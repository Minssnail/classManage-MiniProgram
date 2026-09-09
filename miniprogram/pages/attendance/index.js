const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const qrcode = require('../../utils/qrcode');

// 二维码有效期可选项
const TTL_OPTIONS = [
  { label: '30 秒', value: 30 },
  { label: '60 秒', value: 60 },
  { label: '2 分钟', value: 120 },
  { label: '5 分钟', value: 300 },
];

// 考勤场次：白天面授课与晚修各算一次，同一天互不影响
const SESSIONS = [
  { key: 'day', label: '面授课' },
  { key: 'night', label: '晚修' },
];

const STATUS_POLL_MS = 3000;

// 首次调用摄像头前须明确告知用途并取得同意，同意后不再重复打扰
const CAMERA_CONSENT_KEY = 'cameraConsent';

function stopRefresh() {
  wx.stopPullDownRefresh();
}

Page({
  data: {
    isTeacher: false,
    readonly: false,
    className: '',

    // 教师端
    sessions: SESSIONS,
    session: 'day',
    sessionLabel: '面授课',
    ttlOptions: TTL_OPTIONS,
    ttlIndex: 1,
    autoRefresh: true,
    code: null, // { codeId, content, expireAt, ttl }
    remaining: 0,
    generating: false,
    checkins: [],
    todaySummary: null,

    // 学生端
    myStatus: null,
    scanning: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await app.loadCurrentSemester();

    await app.loadClasses();
    const readonly = app.isReadonlyBrowsing();
    const className = app.effectiveClassName() || '';
    // 切换班级后，之前那个班的二维码就不该继续展示了
    const changed = this.data.className && this.data.className !== className;
    this.setData({
      isTeacher: user.role === 'teacher',
      readonly,
      className,
      code: changed ? null : this.data.code,
      checkins: changed ? [] : this.data.checkins,
    });

    if (readonly) return;
    if (user.role === 'teacher') {
      await this.loadTodaySummary();
      this.startTimers();
    } else {
      await this.loadMyStatus();
    }
  },

  onHide() {
    this.stopTimers();
  },

  onUnload() {
    this.stopTimers();
  },

  onPullDownRefresh() {
    const task = this.data.isTeacher ? this.loadTodaySummary() : this.loadMyStatus();
    task.then(stopRefresh, stopRefresh);
  },

  // ============================================================
  // 教师端：生成短效二维码
  // ============================================================

  // 切换场次：面授课与晚修各自出码，切换时当前这张码就不该继续展示
  onSession(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.session) return;
    const found = SESSIONS.find((x) => x.key === key);
    this.stopTimers();
    this.setData(
      {
        session: key,
        sessionLabel: found ? found.label : key,
        code: null,
        checkins: [],
        remaining: 0,
      },
      () => this.loadTodaySummary()
    );
  },

  onTtlChange(e) {
    this.setData({ ttlIndex: Number(e.detail.value) });
  },

  onAutoRefreshChange(e) {
    this.setData({ autoRefresh: e.detail.value });
  },

  async onGenerate() {
    if (this.data.generating) return;
    this.setData({ generating: true });
    try {
      const ttl = TTL_OPTIONS[this.data.ttlIndex].value;
      const code = await api.call(
        'attendance.createCode',
        { ttl, className: this.data.className, session: this.data.session },
        { loading: false }
      );
      // 以服务端时间为基准计算倒计时，避免手机时钟偏差
      this.clockOffset = code.serverNow - Date.now();
      this.setData({ code, checkins: [], remaining: this.computeRemaining(code) });
      await this.renderQrCode(code.content);
      this.startTimers();
    } catch (e) {
      this.setData({ code: null });
    } finally {
      this.setData({ generating: false });
    }
  },

  computeRemaining(code) {
    if (!code) return 0;
    const serverNow = Date.now() + (this.clockOffset || 0);
    return Math.max(0, Math.ceil((code.expireAt - serverNow) / 1000));
  },

  // 在 Canvas 2D 上绘制二维码
  renderQrCode(content) {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#qrcanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const item = res && res[0];
          if (!item || !item.node) {
            util.toast('二维码画布初始化失败');
            resolve();
            return;
          }
          const canvas = item.node;
          const ctx = canvas.getContext('2d');
          const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2;
          const size = item.width;
          canvas.width = size * dpr;
          canvas.height = size * dpr;
          ctx.scale(dpr, dpr);
          try {
            // 静区留 4 个模块，符合二维码规范，扫码更稳
            qrcode.draw(ctx, content, size, { dark: '#1f2733', light: '#ffffff', padding: 4 });
          } catch (err) {
            util.toast('二维码生成失败：' + err.message);
          }
          resolve();
        });
    });
  },

  startTimers() {
    this.stopTimers();
    this.countdownTimer = setInterval(() => this.tick(), 1000);
    this.pollTimer = setInterval(() => this.pollCodeStatus(), STATUS_POLL_MS);
  },

  stopTimers() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.countdownTimer = null;
    this.pollTimer = null;
  },

  tick() {
    if (!this.data.code) return;
    const remaining = this.computeRemaining(this.data.code);
    if (remaining === this.data.remaining) return;
    this.setData({ remaining });
    if (remaining === 0 && this.data.autoRefresh && !this.data.generating) {
      this.onGenerate();
    }
  },

  // 轮询当前二维码的扫码情况，教师可实时看到谁已打卡
  async pollCodeStatus() {
    if (!this.data.code) return;
    try {
      const res = await api.call(
        'attendance.codeStatus',
        { codeId: this.data.code.codeId },
        { loading: false, silent: true }
      );
      const checkins = res.checkins.map((c) => ({
        ...c,
        time: util.formatTime(c.timestamp),
      }));
      if (checkins.length !== this.data.checkins.length) {
        this.setData({ checkins });
        this.loadTodaySummary();
      }
    } catch (e) {
      // 轮询失败静默处理，下一次继续
    }
  },

  async onRevoke() {
    if (!this.data.code) return;
    try {
      await api.call('attendance.revokeCode', { codeId: this.data.code.codeId });
      this.setData({ code: null, remaining: 0, autoRefresh: false });
      this.stopTimers();
    } catch (e) {
      // 错误提示已在 api 层弹出
    }
  },

  async loadTodaySummary() {
    try {
      const summary = await api.call(
        'attendance.today',
        { className: this.data.className },
        { loading: false }
      );
      // WXML 里按场次取值不方便，这里摊平成两个字段
      const pick = (st, key) => (st.sessions || []).find((x) => x.session === key) || { checkedIn: false };
      this.setData({
        todaySummary: {
          ...summary,
          students: (summary.students || []).map((st) => ({
            ...st,
            dayState: pick(st, 'day'),
            nightState: pick(st, 'night'),
          })),
        },
      });
    } catch (e) {
      // 错误提示已在 api 层弹出
    }
  },

  // 教师补录：学生忘带手机等特殊情况
  async onManualCheckin(e) {
    const studentId = String(e.currentTarget.dataset.id || '').trim();
    const session = String(e.currentTarget.dataset.session || this.data.session);
    if (!studentId) {
      util.toast('缺少学号');
      return;
    }
    const label = (SESSIONS.find((x) => x.key === session) || {}).label || session;
    const ok = await util.confirm(`确认为该学生补录今日${label}考勤吗？`, '补录考勤');
    if (!ok) return;
    try {
      const res = await api.call('attendance.manualCheckin', { studentId, session });
      util.toast(res.message, 'success');
      await this.loadTodaySummary();
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  // ============================================================
  // 学生端：扫码打卡
  // ============================================================

  async loadMyStatus() {
    try {
      const status = await api.call('attendance.today', {}, { loading: false });
      // 兼容旧版云函数：没有 sessions 时退回单场次（面授）
      const sessions = (status.sessions || [
        { session: 'day', sessionLabel: '面授课', checkedIn: status.checkedIn, timestamp: status.timestamp },
      ]).map((x) => ({ ...x, timeText: util.formatDateTime(x.timestamp) }));
      this.setData({
        myStatus: {
          ...status,
          sessions,
          // 两场都打完了才没得可打
          allDone: sessions.every((x) => x.checkedIn),
          doneCount: sessions.filter((x) => x.checkedIn).length,
          timeText: util.formatDateTime(status.timestamp),
        },
      });
    } catch (e) {
      // 错误提示已在 api 层弹出
    }
  },

  async onScan() {
    if (this.data.scanning) return;

    let consented = false;
    try {
      consented = wx.getStorageSync(CAMERA_CONSENT_KEY) === true;
    } catch (e) {
      consented = false;
    }
    if (!consented) {
      const ok = await util.confirm(
        '打卡需要调用摄像头扫描教师出示的考勤二维码。\n\n' +
          '我们仅用它识别二维码，不会拍摄、保存或上传任何图像，扫码结束即关闭摄像头。',
        '摄像头使用说明'
      );
      if (!ok) return;
      try {
        wx.setStorageSync(CAMERA_CONSENT_KEY, true);
      } catch (e) {
        // 写入失败只是下次会再问一次，不影响功能
      }
    }

    this.setData({ scanning: true });
    wx.scanCode({
      // 只允许现场摄像头扫码，杜绝用相册里的二维码截图打卡
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (res) => this.submitCheckin(res.result),
      fail: () => this.setData({ scanning: false }),
    });
  },

  async submitCheckin(content) {
    try {
      const res = await api.call('attendance.checkin', { content });
      wx.showModal({
        title: (res.sessionLabel || '') + '打卡成功',
        content: res.message,
        showCancel: false,
      });
      await this.loadMyStatus();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ scanning: false });
    }
  },

  onOpenDoc(e) {
    wx.navigateTo({ url: '/pages/legal/index?type=' + e.currentTarget.dataset.type });
  },

  onGotoClasses() {
    wx.switchTab({ url: '/pages/dashboard/index' });
  },

  onGotoDashboard() {
    app.globalData.viewingSemester = null;
    wx.switchTab({ url: '/pages/dashboard/index' });
  },
});
