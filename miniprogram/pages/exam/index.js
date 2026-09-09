const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

const TABS = [
  { key: 'summary', label: '成绩汇总' },
  { key: 'list', label: '成绩明细' },
  { key: 'pending', label: '待补考' },
];

Page({
  data: {
    tabs: TABS,
    tab: 'summary',
    isTeacher: false,
    className: '',

    // 统设必修 / 全部课程
    requiredOnly: true,

    // 教师可切换学生；学生固定为本人
    students: [],
    studentIndex: 0,
    studentId: '',

    summary: null,
    myCard: null,
    records: [],
    terms: [],
    termIndex: 0,
    pending: null,
    pendingList: [],  // 带勾选标记的待补考列表
    picked: [],       // 学生端本地勾选状态，提交后才落库
    dirty: false,
    submitting: false,
    exporting: false,
    loaded: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await Promise.all([app.loadClasses(), app.loadCurrentSemester()]);
    const isTeacher = user.role === 'teacher';
    this.setData({ isTeacher, className: app.effectiveClassName() || '' });
    if (isTeacher && !this.data.students.length) await this.loadStudents();
    await this.loadTab();
  },

  onPullDownRefresh() {
    this.loadTab().then(stopRefresh, stopRefresh);
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key }, () => this.loadTab());
  },

  onToggleScope() {
    this.setData({ requiredOnly: !this.data.requiredOnly }, () => this.loadTab());
  },

  onStudent(e) {
    const index = Number(e.detail.value);
    const picked = this.data.students[index];
    this.setData({ studentIndex: index, studentId: picked.studentId || '' }, () => this.loadTab());
  },

  async loadStudents() {
    try {
      const res = await api.call(
        'student.list',
        { className: app.effectiveClassName() || undefined },
        { loading: false, silent: true }
      );
      const list = [{ name: '全班', studentId: '' }].concat(
        res.students.map((s) => ({ name: s.name, studentId: s.studentId }))
      );
      this.setData({ students: list, studentIndex: 0, studentId: '' });
    } catch (e) {
      // 学生列表仅用于筛选，失败不阻塞
    }
  },

  loadTab() {
    if (this.data.tab === 'summary') return this.loadSummary();
    if (this.data.tab === 'list') return this.loadList();
    return this.loadPending();
  },

  baseParams() {
    return {
      className: app.effectiveClassName() || undefined,
      studentId: this.data.studentId || undefined,
    };
  },

  async loadSummary() {
    try {
      const res = await api.call('exam.summary', this.baseParams(), { loading: false });
      const pick = (s) => (this.data.requiredOnly ? s.required : s.all);
      this.setData({
        summary: {
          ...res,
          overallScope: pick(res.overall),
          students: res.students.map((s) => ({
            ...s,
            scope: pick(s),
          })),
        },
        // 学生端只有自己一条，单独提出来做大卡片
        myCard: !this.data.isTeacher && res.students.length ? pick(res.students[0]) : null,
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  onTerm(e) {
    this.setData({ termIndex: Number(e.detail.value) }, () => this.loadList());
  },

  async loadList() {
    const term = this.data.termIndex > 0 ? this.data.terms[this.data.termIndex] : undefined;
    try {
      const res = await api.call(
        'exam.list',
        {
          ...this.baseParams(),
          term,
          requiredOnly: this.data.requiredOnly,
          limit: 300,
        },
        { loading: false }
      );
      this.setData({
        records: res.records.map((r) => ({
          ...r,
          // 要求双及格的课程终考不足 60 分即判无效，综合记 0
          statusClass:
            r.status === '及格' ? 'badge-success' : r.status === '无效' ? 'badge-danger' : 'badge-warning',
          finalText: r.finalScore === null ? '—' : r.finalScore,
          formText: r.formScore === null ? '—' : r.formScore,
        })),
        terms: this.data.terms.length ? this.data.terms : ['全部学期'].concat(res.terms || []),
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  async loadPending() {
    try {
      // 不带 requiredOnly：平均分要分统设必修/全部两种口径，待补考不分，
      // 选修课挂了同样要重修
      const res = await api.call('exam.pending', this.baseParams(), { loading: false });
      // 学生端把服务端的已选状态载入本地，勾选先改本地、提交时一次性落库
      const picked = res.pending.filter((p) => p.selected).map((p) => p.courseCode);
      this.setData({
        pending: res,
        picked,
        pendingList: this.decorate(res.pending, picked),
        dirty: false,
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  // WXML 里不方便判断数组包含关系，勾选状态在这里标好。
  // 教师端一屏里同一门课会出现在多个学生名下，行的键要带上学号
  decorate(list, picked) {
    return list.map((p) => ({
      ...p,
      isPicked: picked.indexOf(p.courseCode) >= 0,
      rowKey: p.studentId + '|' + p.courseCode,
      statusClass: p.status === '无效' ? 'badge-danger' : 'badge-warning',
    }));
  },

  // 学生勾选/取消某门课，仅改本地状态
  onTogglePick(e) {
    if (this.data.isTeacher) return;
    const code = e.currentTarget.dataset.code;
    const picked = this.data.picked.slice();
    const i = picked.indexOf(code);
    if (i >= 0) picked.splice(i, 1);
    else picked.push(code);
    this.setData({
      picked,
      pendingList: this.decorate(this.data.pending.pending, picked),
      dirty: true,
    });
  },

  async onSubmitPicks() {
    if (this.data.submitting) return;
    const count = this.data.picked.length;
    const ok = await util.confirm(
      count
        ? `确认报名以下 ${count} 门补考？提交后可以再修改。`
        : '你没有勾选任何科目，提交后将取消全部补考报名。确定吗？',
      '提交补考报名'
    );
    if (!ok) return;

    this.setData({ submitting: true });
    try {
      const res = await api.call('retake.submit', { courseCodes: this.data.picked });
      util.toast(res.message, 'success');
      await this.loadPending();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 教师代学生勾选，直接落库
  async onTeacherToggle(e) {
    const { code, sid, selected } = e.currentTarget.dataset;
    try {
      const res = await api.call('retake.select', {
        studentId: sid,
        courseCode: code,
        selected: !selected,
      });
      util.toast(res.message, 'success');
      await this.loadPending();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  /**
   * 导出补考选课表：云函数按学校模板生成 xlsx 并传到云存储，
   * 这里下载后用微信的文档预览打开，可再转发或用其他应用保存。
   */
  async onExportRetake() {
    if (this.data.exporting) return;
    const selectedTotal = this.data.pending ? this.data.pending.selectedTotal : 0;

    // 两种版本：学生已报名的，或全部待补考的
    const choice = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: [`学生已选版（${selectedTotal} 条）`, `全部待补考版（${this.data.pending.total} 条）`],
        success: (res) => resolve(res.tapIndex),
        fail: () => resolve(-1),
      });
    });
    if (choice < 0) return;
    const selectedOnly = choice === 0;

    const ok = await util.confirm(
      `将导出${selectedOnly ? '学生已报名的' : '全部待补考的'}科目（必修选修都含），` +
        '格式对齐学校的「批量导入选课记录」模板。',
      '导出补考表'
    );
    if (!ok) return;

    this.setData({ exporting: true });
    wx.showLoading({ title: '生成中', mask: true });
    try {
      // 与页面上的待补考名单同源，同样不套用统设必修口径
      const res = await api.call(
        'exam.exportRetake',
        { ...this.baseParams(), selectedOnly },
        { loading: false }
      );
      wx.showLoading({ title: '下载中', mask: true });
      const file = await wx.cloud.downloadFile({ fileID: res.fileID });
      wx.hideLoading();

      let tip = `已生成 ${res.rowCount} 条选课记录，涉及 ${res.studentCount} 名学生。`;
      if (res.missingStudentId && res.missingStudentId.length) {
        tip +=
          '\n\n以下学生尚未分配学号，模板要求填身份证，系统里没有该字段，' +
          '学号列已留空，请在表格中手动补齐：' +
          res.missingStudentId.join('、');
      }
      tip += '\n\n接下来会打开表格，可通过右上角菜单转发或用其他应用保存。';

      wx.showModal({
        title: '导出成功',
        content: tip,
        showCancel: false,
        success: () => {
          wx.openDocument({
            filePath: file.tempFilePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: () => util.toast('打开表格失败，请稍后重试'),
          });
        },
      });
    } catch (e) {
      wx.hideLoading();
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ exporting: false });
    }
  },

  onExplainAverage() {
    wx.showModal({
      title: '两个平均分的区别',
      content:
        '同一门课重考多次的，统一取综合成绩最高的一次，均为算术平均，不按学分加权。\n\n' +
        '含未过：未通过的课按实际综合成绩计入，要求双及格的课程终考不足 60 分时综合记 0。\n\n' +
        '仅已过：只统计已及格的课程。\n\n' +
        '两个数字差距越大，说明未通过的科目拖累越重。',
      showCancel: false,
    });
  },
});
