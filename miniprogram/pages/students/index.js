const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    className: '',
    name: '',
    studentId: '',
    phone: '',
    submitting: false,
    students: [],
    pendingCount: 0,
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
    await Promise.all([app.loadCurrentSemester(), app.loadClasses()]);
    this.setData({ className: app.effectiveClassName() || '' });
    await this.loadStudents();
  },

  onPullDownRefresh() {
    this.loadStudents().then(stopRefresh, stopRefresh);
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async loadStudents() {
    try {
      const res = await api.call(
        'student.list',
        {
          semesterId: app.effectiveSemesterId(),
          className: app.effectiveClassName() || undefined,
        },
        { loading: false }
      );
      const students = res.students.map((s) => ({
        ...s,
        // 未分配学号的新生展示手机号，避免把占位键当成学号
        idLabel: s.studentIdAssigned ? s.studentId : '待分配学号',
        subLabel: s.phone || (s.studentIdAssigned ? '' : s.studentId),
      }));
      this.setData({
        students,
        pendingCount: students.filter((s) => !s.studentIdAssigned).length,
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  async onAdd() {
    const { name, studentId, phone, className } = this.data;
    if (!className) {
      util.toast('请先在班级管理中选择班级');
      return;
    }
    if (!name.trim()) {
      util.toast('请填写姓名');
      return;
    }
    if (!studentId.trim() && !phone.trim()) {
      util.toast('学号和手机号至少填一个');
      return;
    }

    this.setData({ submitting: true });
    try {
      await api.call('student.add', {
        name: name.trim(),
        studentId: studentId.trim(),
        phone: phone.trim(),
        className,
      });
      const account = studentId.trim() || phone.trim();
      wx.showModal({
        title: '添加成功',
        content: `已创建学生「${name.trim()}」并开通账号：\n登录账号 ${account}，初始密码 student`,
        showCancel: false,
      });
      this.setData({ name: '', studentId: '', phone: '' });
      await this.loadStudents();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 学号下发后补录：服务端会同步迁移账号与该生的积分、奖励记录
  onAssignStudentId(e) {
    const { key, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '补录学号',
      content: `为「${name}」分配学号`,
      editable: true,
      placeholderText: '请输入学号',
      success: async (res) => {
        if (!res.confirm) return;
        const studentId = String(res.content || '').trim();
        if (!studentId) return;
        try {
          const out = await api.call('student.assignStudentId', { currentKey: key, studentId });
          wx.showModal({
            title: '补录成功',
            content: out.message + '\n此后学号与手机号都可以登录。',
            showCancel: false,
          });
          await this.loadStudents();
        } catch (err) {
          // 错误提示已在 api 层弹出
        }
      },
    });
  },

  onGotoClasses() {
    wx.navigateTo({ url: '/pages/classes/index' });
  },
});
