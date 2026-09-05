const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    rewardTypes: util.REWARD_TYPES,
    typeIndex: 0,
    studentId: '',
    className: '',
    reason: '',
    submitting: false,

    students: [],
    rewards: [],
    previewUrl: '',
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
    await Promise.all([this.loadStudents(), this.loadRewards()]);
  },

  onPullDownRefresh() {
    this.loadRewards().then(stopRefresh, stopRefresh);
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
      // 学生列表仅用于快捷选择
    }
  },

  async loadRewards() {
    try {
      const res = await api.call(
        'reward.list',
        { semesterId: app.effectiveSemesterId(), className: app.effectiveClassName() || undefined },
        { loading: false }
      );
      this.setData({
        rewards: res.rewards.map((r) => ({
          ...r,
          timeText: util.formatDateTime(r.timestamp),
          redeemedText: util.formatDateTime(r.redeemedAt),
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
    if (!studentId) {
      util.toast('请填写或选择学号');
      return;
    }

    this.setData({ submitting: true });
    try {
      await api.call('reward.add', {
        studentId,
        rewardType: this.data.rewardTypes[this.data.typeIndex],
        reason: this.data.reason.trim(),
      });
      util.toast('奖励发放成功', 'success');
      this.setData({ reason: '' });
      await this.loadRewards();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onToggleRedeem(e) {
    const { id, redeemed } = e.currentTarget.dataset;
    const action = redeemed ? 'reward.unredeem' : 'reward.redeem';
    const ok = await util.confirm(redeemed ? '确定取消该奖券的兑换状态吗？' : '确认该奖券已兑换？');
    if (!ok) return;
    try {
      const res = await api.call(action, { rewardId: id });
      util.toast(res.message, 'success');
      await this.loadRewards();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  onPreviewCertificate(e) {
    this.setData({ previewUrl: e.currentTarget.dataset.url || '' });
  },

  onClosePreview() {
    this.setData({ previewUrl: '' });
  },
});
