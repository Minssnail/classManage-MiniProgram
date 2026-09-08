const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

const SCOPES = [
  { key: 'all', label: '全部课程' },
  { key: 'required', label: '统设必修' },
];

Page({
  data: {
    scope: 'all',
    scopes: SCOPES,
    keyword: '',
    moduleIndex: 0,
    modules: ['全部模块'],
    major: null,
    summary: null,
    courses: [],
    loaded: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await app.loadClasses();
    await this.loadCourses();
  },

  onPullDownRefresh() {
    this.loadCourses().then(stopRefresh, stopRefresh);
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onScope(e) {
    this.setData({ scope: e.currentTarget.dataset.key }, () => this.loadCourses());
  },

  onModule(e) {
    this.setData({ moduleIndex: Number(e.detail.value) }, () => this.loadCourses());
  },

  onSearch() {
    this.loadCourses();
  },

  onReset() {
    this.setData({ keyword: '', moduleIndex: 0, scope: 'all' }, () => this.loadCourses());
  },

  async loadCourses() {
    const module2 = this.data.moduleIndex > 0 ? this.data.modules[this.data.moduleIndex] : undefined;
    try {
      const res = await api.call(
        'course.list',
        {
          className: app.effectiveClassName() || undefined,
          requiredOnly: this.data.scope === 'required',
          level2Module: module2,
          keyword: this.data.keyword.trim() || undefined,
        },
        { loading: false }
      );
      this.setData({
        major: res.major,
        summary: res.summary,
        modules: ['全部模块'].concat(res.modules || []),
        courses: (res.courses || []).map((c) => ({
          ...c,
          termText: '第 ' + c.suggestedTerm + ' 学期',
        })),
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  // 专业规则未绑定时给出明确指引，而不是让页面空着
  onGotoClasses() {
    if (app.isTeacher()) {
      wx.navigateTo({ url: '/pages/classes/index' });
    } else {
      util.toast('请联系任课教师绑定专业规则');
    }
  },
});
