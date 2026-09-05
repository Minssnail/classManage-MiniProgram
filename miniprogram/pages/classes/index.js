const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    classes: [],
    semesters: [],
    currentClass: '',
    newName: '',
    creating: false,
    loaded: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    if (user.role !== 'teacher') {
      util.toast('需要教师权限');
      wx.navigateBack();
      return;
    }
    await this.loadClasses();
  },

  onPullDownRefresh() {
    this.loadClasses().then(stopRefresh, stopRefresh);
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async loadClasses() {
    try {
      const [list, semesterRes] = await Promise.all([
        app.loadClasses(true),
        api.call('semester.list', {}, { loading: false, silent: true }).catch(() => ({ semesters: [] })),
      ]);
      this.setData({
        classes: list,
        semesters: semesterRes.semesters || [],
        currentClass: app.globalData.currentClass || '',
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  // 入学学期决定该班能看到哪些学期：入学之前的学期不属于这个班
  onSetStartSemester(e) {
    const name = e.currentTarget.dataset.name;
    // showActionSheet 最多 6 项，留一项给「不限制」
    const semesters = this.data.semesters.slice(0, 5);
    const labels = semesters.map((x) => x.name).concat(['不限制（可看全部学期）']);
    wx.showActionSheet({
      itemList: labels,
      success: async (res) => {
        const picked = res.tapIndex < semesters.length ? semesters[res.tapIndex] : null;
        try {
          const out = await api.call('class.setStartSemester', {
            name,
            semesterId: picked ? picked._id : null,
          });
          util.toast(out.message, 'success');
          await this.loadClasses();
        } catch (err) {
          // 错误提示已在 api 层弹出
        }
      },
    });
  },

  // 选中的班级会成为概况、考勤、查询等页面的作用域
  onSetCurrent(e) {
    const name = e.currentTarget.dataset.name;
    app.globalData.currentClass = name;
    this.setData({ currentClass: name });
    util.toast('已切换到 ' + name, 'success');
  },

  async onCreate() {
    const name = this.data.newName.trim();
    if (!name) {
      util.toast('请输入班级名称');
      return;
    }
    this.setData({ creating: true });
    try {
      await api.call('class.create', { name });
      util.toast('班级创建成功', 'success');
      this.setData({ newName: '' });
      await this.loadClasses();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ creating: false });
    }
  },

  async onRename(e) {
    const oldName = e.currentTarget.dataset.name;
    wx.showModal({
      title: '重命名班级',
      editable: true,
      placeholderText: oldName,
      success: async (res) => {
        if (!res.confirm) return;
        const name = String(res.content || '').trim();
        if (!name || name === oldName) return;
        try {
          const out = await api.call('class.rename', { oldName, name });
          util.toast(out.message, 'success');
          if (app.globalData.currentClass === oldName) app.globalData.currentClass = name;
          await this.loadClasses();
        } catch (err) {
          // 错误提示已在 api 层弹出
        }
      },
    });
  },

  async onRemove(e) {
    const name = e.currentTarget.dataset.name;
    const ok = await util.confirm(`确定删除班级「${name}」吗？只有没有学生的班级才能删除。`, '删除班级');
    if (!ok) return;
    try {
      const res = await api.call('class.remove', { name });
      util.toast(res.message, 'success');
      if (app.globalData.currentClass === name) app.globalData.currentClass = null;
      await this.loadClasses();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  onOpenStudents(e) {
    app.globalData.currentClass = e.currentTarget.dataset.name;
    wx.navigateTo({ url: '/pages/students/index' });
  },

  // 导入随包携带的班级名册；按手机号去重，可重复执行
  async onImportRoster() {
    const roster = require('../../data/roster');
    const ok = await util.confirm(
      `将把「${roster.className}」的 ${roster.students.length} 名学生导入系统。\n` +
        '这批新生尚未分配学号，将以手机号作为登录账号，初始密码 student。\n' +
        '已存在的学生会自动跳过。',
      '导入班级名册'
    );
    if (!ok) return;

    try {
      const res = await api.call(
        'class.importRoster',
        { className: roster.className, students: roster.students },
        { loadingText: '导入中' }
      );
      let content = `新导入 ${res.inserted} 人，跳过（已存在）${res.skipped} 人。`;
      if (res.failed && res.failed.length) {
        content += '\n\n失败 ' + res.failed.length + ' 人：';
        content += res.failed.map((f) => f.name + '（' + f.reason + '）').join('；');
      }
      wx.showModal({ title: '导入完成', content, showCancel: false });
      await this.loadClasses();
    } catch (e) {
      // 错误提示已在 api 层弹出
    }
  },
});
