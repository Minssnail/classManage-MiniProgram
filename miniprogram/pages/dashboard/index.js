const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    user: null,
    isTeacher: false,
    className: '',
    classes: [],
    classPanelOpen: false,
    semesterLabel: '',
    semesters: [],
    semesterPanelOpen: false,
    readonly: false,
    overview: null,
    typeBars: [],
    ranking: [],
    bonusRules: util.BONUS_RULES,
    openRule: 0,
    loaded: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await Promise.all([app.loadCurrentSemester(), app.loadClasses()]);
    this.setData({
      user,
      isTeacher: user.role === 'teacher',
      classes: app.globalData.classes,
      className: app.effectiveClassName() || '',
    });
    this.refreshSemesterLabel();
    await this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().then(stopRefresh, stopRefresh);
  },

  refreshSemesterLabel() {
    const semester = app.effectiveSemester();
    let label = semester ? semester.name : '未设置学期';
    if (semester && semester.isArchived) label += '（已存档）';
    if (app.isReadonlyBrowsing()) label += ' · 只读';
    this.setData({ semesterLabel: label, readonly: app.isReadonlyBrowsing() });
  },

  async loadData() {
    const semesterId = app.effectiveSemesterId();
    const className = app.effectiveClassName() || undefined;
    try {
      const [overview, rankingRes] = await Promise.all([
        api.call('stats.overview', { semesterId, className }, { loading: false }),
        api.call('stats.ranking', { semesterId, className }, { loading: false }),
      ]);
      this.setData({
        overview,
        typeBars: this.buildTypeBars(overview.scoreTypeStats),
        ranking: rankingRes.ranking,
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  // 把各类型积分换算成百分比宽度，用于 CSS 条形图
  buildTypeBars(stats) {
    const items = util.SCORE_TYPES.map((t) => ({
      label: t.label,
      value: stats && stats[t.value] ? stats[t.value] : 0,
    }));
    const max = Math.max(1, ...items.map((i) => i.value));
    return items.map((i) => ({ ...i, percent: Math.round((i.value / max) * 100) }));
  },

  async onToggleSemesterPanel() {
    const open = !this.data.semesterPanelOpen;
    if (open && !this.data.semesters.length) {
      try {
        // 学期列表按班级的入学学期过滤：入学之前的学期不属于这个班
        const res = await api.call(
          'semester.list',
          { className: app.effectiveClassName() || undefined },
          { loading: false }
        );
        this.setData({ semesters: res.semesters });
      } catch (e) {
        return;
      }
    }
    this.setData({ semesterPanelOpen: open });
  },

  // 切换到某个学期的只读浏览视图（不改变系统当前学期）
  async onPickSemester(e) {
    const semester = this.data.semesters.find((s) => s._id === e.currentTarget.dataset.id);
    if (!semester) return;
    const current = app.globalData.currentSemester;
    app.globalData.viewingSemester = current && current._id === semester._id ? null : semester;
    this.setData({ semesterPanelOpen: false });
    this.refreshSemesterLabel();
    await this.loadData();
    if (app.isReadonlyBrowsing()) {
      wx.showModal({
        title: '只读浏览',
        content: `正在查看「${semester.name}」的历史数据，仅可浏览。考勤打卡等操作请先返回当前学期。`,
        showCancel: false,
      });
    }
  },

  async onExitBrowse() {
    app.globalData.viewingSemester = null;
    this.refreshSemesterLabel();
    await this.loadData();
  },

  // 教师切换班级；学生没有这个入口
  onToggleClassPanel() {
    if (!this.data.isTeacher) return;
    this.setData({ classPanelOpen: !this.data.classPanelOpen });
  },

  async onPickClass(e) {
    const name = e.currentTarget.dataset.name;
    app.globalData.currentClass = name;
    // 换班后可见学期范围会变，正在浏览的历史学期可能已不属于新班级，一并重置
    app.globalData.viewingSemester = null;
    this.setData({ className: name, classPanelOpen: false, semesters: [] });
    this.refreshSemesterLabel();
    await this.loadData();
  },

  onToggleRule(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ openRule: this.data.openRule === index ? -1 : index });
  },
});
