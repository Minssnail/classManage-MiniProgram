const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

// 积分类型筛选项：首项为「全部」
const TYPE_FILTERS = [{ value: '', label: '全部类型' }].concat(util.SCORE_TYPES);

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    tab: 'score',
    isTeacher: false,
    semesterLabel: '',
    className: '',

    typeFilters: TYPE_FILTERS,
    typeIndex: 0,
    studentId: '',

    records: [],
    total: 0,
    rewards: [],
    previewUrl: '',
    loaded: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await Promise.all([app.loadCurrentSemester(), app.loadClasses()]);
    const semester = app.effectiveSemester();
    this.setData({
      isTeacher: user.role === 'teacher',
      semesterLabel: semester ? semester.name : '全部学期',
      className: app.effectiveClassName() || '',
    });
    await this.loadCurrentTab();
  },

  onPullDownRefresh() {
    this.loadCurrentTab().then(stopRefresh, stopRefresh);
  },

  onSwitchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab }, () => this.loadCurrentTab());
  },

  loadCurrentTab() {
    return this.data.tab === 'score' ? this.loadScores() : this.loadRewards();
  },

  onStudentIdInput(e) {
    this.setData({ studentId: e.detail.value });
  },

  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) }, () => this.loadScores());
  },

  onSearch() {
    this.loadCurrentTab();
  },

  onReset() {
    this.setData({ studentId: '', typeIndex: 0 }, () => this.loadCurrentTab());
  },

  async loadScores() {
    try {
      const res = await api.call(
        'score.list',
        {
          studentId: this.data.studentId.trim() || undefined,
          scoreType: TYPE_FILTERS[this.data.typeIndex].value || undefined,
          semesterId: app.effectiveSemesterId(),
          className: app.effectiveClassName() || undefined,
        },
        { loading: false }
      );
      this.setData({
        records: res.records.map((r) => ({
          ...r,
          typeLabel: util.recordTypeLabel(r),
          timeText: util.formatDateTime(r.timestamp),
          studentText: util.displayStudent(r.studentName, r.studentId),
        })),
        total: res.total,
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  async loadRewards() {
    try {
      const res = await api.call(
        'reward.list',
        {
          studentId: this.data.isTeacher ? this.data.studentId.trim() || undefined : undefined,
          semesterId: app.effectiveSemesterId(),
          className: app.effectiveClassName() || undefined,
        },
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

  // 奖券图片打包在小程序内，wx.previewImage 不支持本地包路径，这里用页内浮层预览
  onPreviewCertificate(e) {
    const url = e.currentTarget.dataset.url;
    if (url) this.setData({ previewUrl: url });
  },

  onClosePreview() {
    this.setData({ previewUrl: '' });
  },
});
