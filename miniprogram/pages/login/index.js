const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    username: '',
    password: '',
    submitting: false,
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async onSubmit() {
    const username = this.data.username.trim();
    const password = this.data.password;
    if (!username || !password) {
      util.toast('请输入用户名和密码');
      return;
    }

    this.setData({ submitting: true });
    try {
      const res = await api.call('auth.login', { username, password });
      app.globalData.user = res.user;
      app.globalData.viewingSemester = null;
      app.readyPromise = Promise.resolve(res.user);
      app.globalData.currentClass = null;
      await Promise.all([app.loadCurrentSemester(true), app.loadClasses(true)]);
      wx.switchTab({ url: '/pages/dashboard/index' });
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },
});
