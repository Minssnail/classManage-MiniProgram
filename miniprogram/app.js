// app.js
const config = require('./config');
const api = require('./utils/api');

App({
  globalData: {
    user: null, // 当前登录用户
    currentSemester: null, // 系统当前学期（按日期自动判定）
    viewingSemester: null, // 本地浏览的历史学期，仅影响前端过滤
    currentClass: null, // 教师当前查看的班级名；学生固定为自己所在班级
    classes: [], // 班级列表缓存
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: config.cloudEnv || undefined,
      traceUser: true,
    });
    this.readyPromise = this.refreshUser();
  },

  // 拉取当前登录用户（以微信 openid 为准，无需本地保存凭证）
  async refreshUser() {
    try {
      const res = await api.call('auth.me', {}, { silent: true, loading: false });
      this.globalData.user = res.user;
    } catch (e) {
      this.globalData.user = null;
    }
    return this.globalData.user;
  },

  // 页面在 onShow 中调用：等待登录态就绪，未登录则跳转登录页
  async requireUser(options = {}) {
    if (!this.readyPromise) this.readyPromise = this.refreshUser();
    await this.readyPromise;
    if (!this.globalData.user && options.redirect !== false) {
      wx.reLaunch({ url: '/pages/login/index' });
      return null;
    }
    return this.globalData.user;
  },

  isTeacher() {
    return !!this.globalData.user && this.globalData.user.role === 'teacher';
  },

  // 当前生效的查看学期：本地浏览学期优先，否则系统当前学期
  effectiveSemester() {
    return this.globalData.viewingSemester || this.globalData.currentSemester;
  },

  effectiveSemesterId() {
    const semester = this.effectiveSemester();
    return semester ? semester._id : null;
  },

  // 学生正在只读浏览非当前学期的历史数据
  isReadonlyBrowsing() {
    const { user, viewingSemester, currentSemester } = this.globalData;
    if (!viewingSemester || !user) return false;
    if (currentSemester && viewingSemester._id === currentSemester._id) return false;
    return true;
  },

  // 当前生效的班级：学生锁定在自己班级，教师用所选班级（未选则为全部）
  effectiveClassName() {
    const user = this.globalData.user;
    if (user && user.role === 'student') return user.className || null;
    return this.globalData.currentClass || null;
  },

  // 加载班级列表；教师首次进入时默认选中第一个班级，避免"全部班级"的混合视图
  async loadClasses(force = false) {
    if (this.globalData.classes.length && !force) return this.globalData.classes;
    try {
      const res = await api.call('class.list', {}, { silent: true, loading: false });
      this.globalData.classes = res.classes || [];
    } catch (e) {
      this.globalData.classes = [];
    }
    const list = this.globalData.classes;
    if (this.isTeacher()) {
      const stillExists = list.some((c) => c.name === this.globalData.currentClass);
      if (!stillExists) this.globalData.currentClass = list.length ? list[0].name : null;
    }
    return list;
  },

  async loadCurrentSemester(force = false) {
    if (this.globalData.currentSemester && !force) return this.globalData.currentSemester;
    try {
      const res = await api.call('semester.current', {}, { silent: true, loading: false });
      this.globalData.currentSemester = res.semester;
    } catch (e) {
      this.globalData.currentSemester = null;
    }
    return this.globalData.currentSemester;
  },

  // 退出登录：解绑 openid 并清空本地状态
  async signOut() {
    try {
      await api.call('auth.logout', {}, { silent: true });
    } finally {
      this.globalData.user = null;
      this.globalData.viewingSemester = null;
      this.globalData.currentClass = null;
      this.globalData.classes = [];
      this.readyPromise = Promise.resolve(null);
    }
  },
});
