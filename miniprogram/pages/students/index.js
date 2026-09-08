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
    majors: [],
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
        // 单独绑定过规则的标出来，其余沿用班级默认
        ruleLabel: s.ruleName ? s.ruleName + (s.ownRuleCode ? '（单独指定）' : '') : '未绑定专业规则',
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

  // 学生改过密码又忘记时无法自助找回，只能由教师重置
  async onResetPassword(e) {
    const { key, name } = e.currentTarget.dataset;
    const ok = await util.confirm(
      `将把「${name}」的密码重置为 student，并解除其微信绑定，` +
        '该学生需要用初始密码重新登录。确定重置吗？',
      '重置密码'
    );
    if (!ok) return;
    try {
      const res = await api.call('student.resetPassword', { account: key });
      wx.showModal({
        title: '重置成功',
        content:
          `${res.name}\n登录账号：${res.loginAccount}\n初始密码：${res.initialPassword}\n\n` +
          '请提醒该学生登录后立即修改密码。',
        showCancel: false,
      });
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  // 同一个班可能混着不同入学年份的学生，可按人指定规则版本
  async onSetStudentRule(e) {
    const { key, name } = e.currentTarget.dataset;
    if (!this.data.majors.length) {
      try {
        const res = await api.call('major.list', {}, { loading: false, silent: true });
        this.setData({ majors: res.majors || [] });
      } catch (err) {
        // 下面会提示
      }
    }
    const majors = this.data.majors.slice(0, 5);
    if (!majors.length) {
      util.toast('请先在「我的 → 导入课程与成绩」中导入专业规则');
      return;
    }
    const labels = majors.map((m) => m.name + ' ' + m.enrollTerm);
    wx.showActionSheet({
      itemList: labels.concat(['沿用班级默认']),
      success: async (res) => {
        const picked = res.tapIndex < majors.length ? majors[res.tapIndex] : null;
        try {
          const out = await api.call('student.setRule', {
            studentId: key,
            ruleCode: picked ? picked.ruleCode : '',
          });
          util.toast(out.message, 'success');
          await this.loadStudents();
        } catch (err) {
          // 错误提示已在 api 层弹出
        }
      },
    });
  },

  onOpenPrivacy(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  onGotoClasses() {
    wx.navigateTo({ url: '/pages/classes/index' });
  },
});
