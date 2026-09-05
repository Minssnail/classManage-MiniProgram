const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    scoreTypes: util.SCORE_TYPES,
    typeIndex: 1, // 默认「课堂表现加分」，考勤分由扫码自动产生
    studentId: '',
    className: '',
    score: '',
    reason: '',
    submitting: false,

    students: [],
    records: [],
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
    await Promise.all([this.loadStudents(), this.loadRecords()]);
  },

  onPullDownRefresh() {
    this.loadRecords().then(stopRefresh, stopRefresh);
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) });
  },

  onPickStudent(e) {
    this.setData({ studentId: e.currentTarget.dataset.id });
  },

  async loadStudents() {
    try {
      const res = await api.call(
        'student.list',
        { semesterId: app.effectiveSemesterId(), className: app.effectiveClassName() || undefined },
        { loading: false, silent: true }
      );
      this.setData({ students: res.students });
    } catch (e) {
      // 学生列表仅用于快捷选择，失败不阻塞录入
    }
  },

  async loadRecords() {
    try {
      const res = await api.call(
        'score.list',
        {
          semesterId: app.effectiveSemesterId(),
          className: app.effectiveClassName() || undefined,
          limit: 50,
        },
        { loading: false }
      );
      this.setData({
        records: res.records.map((r) => ({
          ...r,
          typeLabel: util.SCORE_TYPE_LABELS[r.scoreType] || r.scoreType,
          timeText: util.formatDateTime(r.timestamp),
          studentText: util.displayStudent(r.studentName, r.studentId),
        })),
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  async onSubmit() {
    const studentId = this.data.studentId.trim();
    const score = Number(this.data.score);
    if (!studentId) {
      util.toast('请填写或选择学号');
      return;
    }
    if (!score) {
      util.toast('请填写非零分值');
      return;
    }

    this.setData({ submitting: true });
    try {
      await api.call('score.add', {
        studentId,
        scoreType: this.data.scoreTypes[this.data.typeIndex].value,
        score,
        reason: this.data.reason.trim(),
        semesterId: app.effectiveSemesterId(),
      });
      util.toast('加分成功', 'success');
      this.setData({ score: '', reason: '' });
      await Promise.all([this.loadRecords(), this.loadStudents()]);
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },
});
