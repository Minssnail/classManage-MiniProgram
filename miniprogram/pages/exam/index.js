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
      const res = await api.call(
        'exam.pending',
        { ...this.baseParams(), requiredOnly: this.data.requiredOnly },
        { loading: false }
      );
      this.setData({ pending: res, loaded: true });
    } catch (e) {
      this.setData({ loaded: true });
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
