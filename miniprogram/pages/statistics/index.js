const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    isTeacher: false,
    className: '',
    semesterLabel: '',
    trendTitle: '',
    bars: [],
    maxValue: 0,
    totalWeek: 0,
    typeBars: [],
    loaded: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await Promise.all([app.loadCurrentSemester(), app.loadClasses()]);
    const semester = app.effectiveSemester();
    this.setData({
      isTeacher: user.role === 'teacher',
      className: app.effectiveClassName() || '',
      semesterLabel: semester ? semester.name : '全部学期',
      trendTitle: user.role === 'teacher' ? '本班近 7 天积分趋势' : '我的近 7 天积分趋势',
    });
    await this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().then(stopRefresh, stopRefresh);
  },

  async loadData() {
    const semesterId = app.effectiveSemesterId();
    const className = app.effectiveClassName() || undefined;
    try {
      const [trend, overview] = await Promise.all([
        api.call('stats.trend', { semesterId, className }, { loading: false }),
        api.call('stats.overview', { semesterId, className }, { loading: false }),
      ]);

      const max = Math.max(1, ...trend.values);
      this.setData({
        bars: trend.labels.map((label, i) => ({
          label,
          value: trend.values[i],
          // 保留最小高度，让 0 分的日期也能看到基线
          percent: Math.max(3, Math.round((trend.values[i] / max) * 100)),
        })),
        maxValue: max,
        totalWeek: trend.values.reduce((sum, v) => sum + v, 0),
        typeBars: this.buildTypeBars(overview.scoreTypeStats),
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  buildTypeBars(stats) {
    const items = util.SCORE_TYPES.map((t) => ({
      label: t.label,
      value: stats && stats[t.value] ? stats[t.value] : 0,
    }));
    const total = items.reduce((sum, i) => sum + i.value, 0);
    const max = Math.max(1, ...items.map((i) => i.value));
    return items.map((i) => ({
      ...i,
      percent: Math.round((i.value / max) * 100),
      share: total ? Math.round((i.value / total) * 100) : 0,
    }));
  },
});
