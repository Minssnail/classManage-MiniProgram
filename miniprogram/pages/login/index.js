const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

// 同意记录存本地：同意过的下次自动勾选，首次使用必须由用户主动勾选
const AGREED_KEY = 'legalAgreedVersion';
const AGREEMENT_VERSION = '2026-09-07';

Page({
  data: {
    username: '',
    password: '',
    agreed: false,
    submitting: false,
  },

  onLoad() {
    let agreed = false;
    try {
      agreed = wx.getStorageSync(AGREED_KEY) === AGREEMENT_VERSION;
    } catch (e) {
      agreed = false;
    }
    this.setData({ agreed });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  onOpenDoc(e) {
    wx.navigateTo({ url: '/pages/legal/index?type=' + e.currentTarget.dataset.type });
  },

  async onSubmit() {
    // 未取得授权同意前不得收集任何信息，因此同意是登录的前置条件
    if (!this.data.agreed) {
      util.toast('请先阅读并同意《用户服务协议》和《隐私政策》');
      return;
    }

    const username = this.data.username.trim();
    const password = this.data.password;
    if (!username || !password) {
      util.toast('请输入账号和密码');
      return;
    }

    this.setData({ submitting: true });
    try {
      const res = await api.call('auth.login', { username, password });
      try {
        wx.setStorageSync(AGREED_KEY, AGREEMENT_VERSION);
      } catch (e) {
        // 本地缓存写入失败不影响登录，只是下次仍需重新勾选
      }
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
