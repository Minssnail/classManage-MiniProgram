const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    name: '',
    startDate: '',
    endDate: '',
    submitting: false,
    semesters: [],
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
    await this.loadSemesters();
  },

  onPullDownRefresh() {
    this.loadSemesters().then(stopRefresh, stopRefresh);
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onDateChange(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async loadSemesters() {
    try {
      const res = await api.call('semester.list', {}, { loading: false });
      this.setData({ semesters: res.semesters, loaded: true });
      // 学期结构可能变化，刷新全局的当前学期
      await app.loadCurrentSemester(true);
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  async onCreate() {
    const { name, startDate, endDate } = this.data;
    if (!name.trim() || !startDate || !endDate) {
      util.toast('请填写学期名称与起止日期');
      return;
    }

    this.setData({ submitting: true });
    try {
      await api.call('semester.create', { name: name.trim(), startDate, endDate });
      util.toast('学期创建成功', 'success');
      this.setData({ name: '', startDate: '', endDate: '' });
      await this.loadSemesters();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onSetCurrent(e) {
    try {
      const res = await api.call('semester.setCurrent', { semesterId: e.currentTarget.dataset.id });
      util.toast(res.message, 'success');
      await this.loadSemesters();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  async onArchive(e) {
    const ok = await util.confirm('存档后该学期变为历史只读数据，确定存档吗？', '存档学期');
    if (!ok) return;
    try {
      const res = await api.call('semester.archive', { semesterId: e.currentTarget.dataset.id });
      util.toast(res.message, 'success');
      await this.loadSemesters();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  async onRemove(e) {
    const ok = await util.confirm(
      '删除后该学期下的积分与奖励记录会解除学期归属，但记录本身保留。确定删除吗？',
      '删除学期'
    );
    if (!ok) return;
    try {
      const res = await api.call('semester.remove', { semesterId: e.currentTarget.dataset.id });
      util.toast(res.message, 'success');
      await this.loadSemesters();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },
});
