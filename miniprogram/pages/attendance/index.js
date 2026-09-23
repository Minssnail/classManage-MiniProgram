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

// 考勤异常，与云函数的 MARK_STATUSES 对应
const MARK_STATUSES = [
  { key: 'leave', name: '请假' },
  { key: 'late', name: '迟到' },
  { key: 'early', name: '早退' },
  { key: 'absent', name: '缺勤' },
];

const STATUS_POLL_MS = 3000;

// 首次调用摄像头前须明确告知用途并取得同意，同意后不再重复打扰
const CAMERA_CONSENT_KEY = 'cameraConsent';

/**
 * 把一周的异常整理成「哪天 · 哪一场 · 什么情况」。
 *
 * 当天两场都是同一种情况时合成一条「全天」——整周缺勤的人否则会排出一长串
 * 一模一样的徽标；也与「一天请假只算一次」的口径相合。
 */
function buildExceptions(detail) {
  const byDay = {};
  for (const d of detail || []) {
    if (d.status === 'present') continue;
    (byDay[d.day] = byDay[d.day] || []).push(d);
  }
  const sameDayTotal = {};
  for (const d of detail || []) sameDayTotal[d.day] = (sameDayTotal[d.day] || 0) + 1;

  const out = [];
  for (const day of Object.keys(byDay).sort()) {
    const rows = byDay[day];
    const label = day.slice(5).replace('-', '/');
    const statuses = [...new Set(rows.map((r) => r.status))];
    // 这一天纳入评定的场次全都是同一种情况，才算「全天」
    if (statuses.length === 1 && rows.length > 1 && rows.length === sameDayTotal[day]) {
      const note = rows.find((r) => r.note);
      out.push({
        key: day,
        status: rows[0].status,
        text: label + ' 全天 ' + rows[0].statusLabel + (note ? '（' + note.note + '）' : ''),
      });
      continue;
    }
    for (const r of rows) {
      out.push({
        key: day + r.session,
        status: r.status,
        text: label + ' ' + r.sessionLabel + ' ' + r.statusLabel + (r.note ? '（' + r.note + '）' : ''),
      });
    }
  }
  return out;
}

/**
 * 这一格能不能操作；不能的话给出确切原因。
 *
 * 不要从 required 反推原因：required 为 false 既可能是走读生不参加晚修，
 * 也可能是这一场停课了，混在一起就会把「已停课」说成「是走读生」。
 * 是不是走读生看学生本人的住宿情况，与 required 无关。
 */
function cellBlockReason(row, state, session) {
  if (state && state.suspended) return '这一场已停课，无需考勤';
  if (session === 'night' && row && row.lodging === 'commuting') {
    return (row.name || '该学生') + ' 是走读生，不参加晚修';
  }
  return null;
}

function stopRefresh() {
  wx.stopPullDownRefresh();
}

function labelOf(session) {
  const found = SESSIONS.find((x) => x.key === session);
  return found ? found.label : session;
}

/**
 * 把一个人两场的状态整理成界面要的样子。
 * 走读生不参加晚修：required 为 false，既不算进「已打 / 应打」，也不显示「未打卡」。
 */
function decorateSessions(sessions) {
  const list = (sessions || []).map((x) => ({
    ...x,
    required: x.required !== false,
    timeText: util.formatDateTime(x.timestamp),
    // 被教师标了请假之类的，学生自己也要看得到
    stateText: x.statusLabel
      ? x.statusLabel + (x.checkedIn ? ' · ' + util.formatDateTime(x.timestamp) : '')
      : x.checkedIn
        ? util.formatDateTime(x.timestamp)
        : x.required === false
          ? '走读生无需打卡'
          : '未打卡',
  }));
  // 已请假的场次不必再打卡，不计入「还差几场」
  const required = list.filter((x) => x.required && x.status !== 'leave');
  return {
    sessions: list,
    requiredCount: required.length,
    doneCount: required.filter((x) => x.checkedIn).length,
    allDone: required.length > 0 && required.every((x) => x.checkedIn),
  };
}

Page({
  data: {
    // 三种身份：教师出码并补录；班长协助出码、本人免扫码打卡、看名单；普通学生扫码
    isTeacher: false,
    isMonitor: false,
    monitorTab: 'present', // present 出示考勤码 / mine 我的打卡
    readonly: false,
    className: '',

    // 出码（教师与班长共用）
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

    // 班长本人在当前场次的状态
    selfChecking: false,
    myRow: null,

    // 名单查看的日期，默认今天
    day: '',
    today: '',
    isToday: true,

    // 本周考勤与全勤加分
    week: null,
    weekStart: '',
    settling: false,

    // 学生端
    myStatus: null,
    scanning: false,
  },

  async onShow() {
    const cached = await app.requireUser();
    if (!cached) return;
    // 教师可能刚给这个学生设了或撤了班长，每次进来重新拉一次身份。
    // 要区分两种情况：服务端明确说没登录（比如密码被重置、解了绑）就回登录页；
    // 只是请求失败（网络抖动）就沿用缓存——权限最终仍以服务端逐次校验为准
    let user = cached;
    try {
      const res = await api.call('auth.me', {}, { silent: true, loading: false });
      if (!res.user) {
        app.globalData.user = null;
        wx.reLaunch({ url: '/pages/login/index' });
        return;
      }
      user = res.user;
      app.globalData.user = user;
    } catch (e) {
      // 沿用缓存
    }
    await app.loadCurrentSemester();

    await app.loadClasses();
    const readonly = app.isReadonlyBrowsing();
    const className = app.effectiveClassName() || '';
    const isTeacher = user.role === 'teacher';
    const isMonitor = !isTeacher && !!user.canAssistAttendance;

    // 切换班级或卸任班长后，之前那张二维码就不该继续展示了
    const changed =
      (this.data.className && this.data.className !== className) ||
      (this.data.isMonitor && !isMonitor);
    this.setData({
      isTeacher,
      isMonitor,
      readonly,
      className,
      code: changed ? null : this.data.code,
      checkins: changed ? [] : this.data.checkins,
    });
    if (changed) this.stopTimers();

    if (readonly) return;
    if (isTeacher || isMonitor) {
      await Promise.all([this.loadTodaySummary(), this.loadWeek()]);
      this.startTimers();
      // 从别的页面回来时画布是新挂载的，要重画
      if (this.data.code && this.onPresentTab()) this.renderQrCode(this.data.code.content);
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
    const task =
      this.data.isTeacher || this.data.isMonitor
        ? Promise.all([this.loadTodaySummary(), this.loadWeek()])
        : this.loadMyStatus();
    task.then(stopRefresh, stopRefresh);
  },

  // 教师始终在出码界面；班长要看当前是不是在「出示考勤码」页签
  onPresentTab() {
    return this.data.isTeacher || (this.data.isMonitor && this.data.monitorTab === 'present');
  },

  onMonitorTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.monitorTab) return;
    this.setData({ monitorTab: tab }, () => {
      // 切回出码页签时画布重新挂载，二维码要重画一遍
      if (tab === 'present' && this.data.code && this.data.remaining > 0) {
        setTimeout(() => this.renderQrCode(this.data.code.content), 50);
      }
    });
  },

  // ============================================================
  // 出码：教师与班长
  // ============================================================

  // 切换场次：面授课与晚修各自出码，切换时当前这张码就不该继续展示
  onSession(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.session) return;
    this.stopTimers();
    this.setData(
      {
        session: key,
        sessionLabel: labelOf(key),
        code: null,
        checkins: [],
        remaining: 0,
      },
      () => {
        this.refreshMyRow();
        this.loadTodaySummary();
      }
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
    const suspended = (this.data.todaySummary && this.data.todaySummary.suspendedSessions) || {};
    if (this.data.isToday && suspended[this.data.session] && suspended[this.data.session].suspended) {
      util.toast(`今日${this.data.sessionLabel}已停课，如需考勤请先取消停课`);
      return;
    }
    this.setData({ generating: true });
    try {
      const ttl = TTL_OPTIONS[this.data.ttlIndex].value;
      // 班长传不传班级都一样，服务端会强制为本班
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
      // 班长切到「我的打卡」时画布不在页面上，自动刷新出的新码等切回来再画
      if (!this.onPresentTab()) {
        resolve();
        return;
      }
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

  // 轮询当前二维码的扫码情况，实时看到谁已打卡
  async pollCodeStatus() {
    if (!this.data.code) return;
    try {
      const res = await api.call(
        'attendance.codeStatus',
        { codeId: this.data.code.codeId, className: this.data.className },
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
      await api.call('attendance.revokeCode', {
        codeId: this.data.code.codeId,
        className: this.data.className,
      });
      this.setData({ code: null, remaining: 0, autoRefresh: false });
      this.stopTimers();
    } catch (e) {
      // 错误提示已在 api 层弹出
    }
  },

  /**
   * 停课：这一场不上课，学生无需打卡，也不纳入全勤评定。
   * 与「当天没出过考勤码」不同——课已经排了甚至码都出了，临时停掉，
   * 需要一条明确记录把它从统计里摘出去。
   */
  async onToggleSuspend(e) {
    // 班长看得到停课状态，但停不停课是教师定的
    if (!this.data.isTeacher) {
      util.toast('停课由班主任设置');
      return;
    }
    const session = e.currentTarget.dataset.session;
    const state = (this.data.todaySummary.suspendedSessions || {})[session] || {};
    const label = session === 'night' ? '晚修' : '面授课';
    const day = this.data.day;

    if (state.suspended) {
      const ok = await util.confirm(`恢复 ${day} 的${label}考勤吗？`, '恢复上课');
      if (!ok) return;
      try {
        const res = await api.call('attendance.suspend', {
          className: this.data.className,
          day,
          session,
          suspended: false,
        });
        util.toast(res.message, 'success');
        await Promise.all([this.loadTodaySummary(), this.loadWeek()]);
      } catch (err) {
        // 错误提示已在 api 层弹出
      }
      return;
    }

    const reason = await new Promise((resolve) => {
      wx.showModal({
        title: `${label}停课`,
        content: `${day} 的${label}将标为停课：学生无需打卡，这一场也不计入全勤评定。`,
        editable: true,
        placeholderText: '停课原因（选填，如：放假、台风）',
        success: (res) => resolve(res.confirm ? String(res.content || '') : null),
        fail: () => resolve(null),
      });
    });
    if (reason === null) return;

    try {
      const res = await api.call('attendance.suspend', {
        className: this.data.className,
        day,
        session,
        reason,
      });
      util.toast(res.message, 'success');
      await Promise.all([this.loadTodaySummary(), this.loadWeek()]);
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  // 翻到别的日期补标记
  onDay(e) {
    const day = e.detail.value;
    if (day === this.data.day) return;
    this.setData({ day }, () => this.loadTodaySummary());
  },

  onBackToToday() {
    if (this.data.isToday) return;
    this.setData({ day: this.data.today || '' }, () => this.loadTodaySummary());
  },

  async loadTodaySummary() {
    try {
      const summary = await api.call(
        'attendance.today',
        { className: this.data.className, day: this.data.day || undefined },
        { loading: false }
      );
      // WXML 里按场次取值不方便，这里摊平成两个字段
      const pick = (st, key) =>
        (st.sessions || []).find((x) => x.session === key) || { checkedIn: false, required: true };
      const students = (summary.students || []).map((st) => ({
        ...st,
        // 老版本云函数没有 rowKey 时退回学号
        rowKey: st.rowKey || st.studentId,
        idText: st.studentIdAssigned
          ? st.studentId
          : '待分配学号' + (st.phone ? ' · ' + st.phone : ''),
        dayState: pick(st, 'day'),
        nightState: pick(st, 'night'),
      }));
      this.setData(
        {
          todaySummary: { ...summary, students },
          day: summary.day,
          isToday: summary.isToday !== false,
          today: summary.isToday !== false ? summary.day : this.data.today,
        },
        () => this.refreshMyRow()
      );
    } catch (e) {
      // 错误提示已在 api 层弹出
    }
  },

  /**
   * 点名单里的某一格：教师可补录出勤或标记异常，班长只能标记异常。
   * 补录写的是考勤记录（加 1 分），标记写的是异常，两者互不覆盖。
   */
  async onCell(e) {
    const { id, session, name } = e.currentTarget.dataset;
    const row = this.data.todaySummary.students.find((s) => s.studentId === id);
    if (!row) return;
    const state = (session === 'night' ? row.nightState : row.dayState) || {};
    const blocked = cellBlockReason(row, state, session);
    if (blocked) {
      util.toast(blocked);
      return;
    }

    const actions = [];
    if (this.data.isTeacher && !state.checkedIn) actions.push({ key: 'checkin', label: '补录出勤' });
    // 补错日期、扫错码都需要能收回
    if (this.data.isTeacher && state.checkedIn) actions.push({ key: 'undo', label: '撤销出勤' });
    for (const s of MARK_STATUSES) {
      if (s.key !== state.status) actions.push({ key: 'mark', status: s.key, label: '标记' + s.name });
    }
    if (state.status) actions.push({ key: 'clear', label: '清除标记（' + state.statusLabel + '）' });

    const picked = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: actions.map((a) => a.label),
        success: (res) => resolve(actions[res.tapIndex]),
        fail: () => resolve(null),
      });
    });
    if (!picked) return;

    try {
      if (picked.key === 'undo') {
        const ok = await util.confirm(
          `将撤销 ${name} ${this.data.day} ${session === 'night' ? '晚修' : '面授课'}的打卡记录，并扣回相应的 1 分。`,
          '撤销出勤'
        );
        if (!ok) return;
        const res = await api.call('attendance.undoCheckin', {
          studentId: id,
          day: this.data.day || undefined,
          session,
        });
        util.toast(res.message, 'success');
      } else if (picked.key === 'checkin') {
        // 补的是当前查看的那一天，不是今天
        const res = await api.call('attendance.manualCheckin', {
          studentId: id,
          day: this.data.day || undefined,
          session,
        });
        util.toast(res.message, 'success');
      } else {
        const res = await api.call('attendance.mark', {
          studentId: id,
          day: this.data.day || undefined,
          session,
          status: picked.key === 'clear' ? '' : picked.status,
        });
        util.toast(res.message, 'success');
      }
      await Promise.all([this.loadTodaySummary(), this.loadWeek()]);
    } catch (err) {
      // 错误提示已在 api 层弹出
    }
  },

  // ============================================================
  // 全勤加分
  // ============================================================

  async loadWeek() {
    try {
      const week = await api.call(
        'attendance.weekSummary',
        { className: this.data.className, weekStart: this.data.weekStart || undefined },
        { loading: false, silent: true }
      );
      this.setData({
        weekStart: week.weekStart,
        week: {
          ...week,
          countedText: (week.countedSessionLabels || ['面授课', '晚修']).join('、'),
          students: week.students.map((s) => ({
            ...s,
            // 有异常的逐条列出日期与场次，教师一眼能核对是哪天哪一场
            exceptions: buildExceptions(s.detail),
            // 一眼看出这人这周为什么是这个分
            summaryText:
              `出勤 ${s.attended}/${s.sessionCount} 场` +
              (s.leaveDays ? ` · 请假 ${s.leaveDays} 天` : '') +
              (s.lateEarlyCount ? ` · 迟到早退 ${s.lateEarlyCount} 次` : '') +
              (s.absentDays ? ` · 缺勤 ${s.absentDays} 天` : ''),
          })),
        },
      });
    } catch (e) {
      // 老版本云函数没有这个接口时不显示这张卡
      this.setData({ week: null });
    }
  },

  onWeekShift(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const base = this.data.weekStart || this.data.today;
    if (!base) return;
    const d = new Date(base + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + delta * 7);
    this.setData({ weekStart: d.toISOString().slice(0, 10) }, () => this.loadWeek());
  },

  /**
   * 重算以往各周：改了全勤口径或补了标记之后，把过去已发的分一并更正。
   * 以往周次的「计算结果」本来就随设置立刻变，这个动作改的是已经发出去的分。
   */
  async onSettleHistory() {
    if (this.data.settling) return;
    const ok = await util.confirm(
      '将按当前的全勤口径，把本班以往每一周重新结算一遍：\n\n' +
        '该加的补上、该改的改过来、不该有的撤回，不会重复加分。本周尚未结束，不在其中。',
      '重算以往各周'
    );
    if (!ok) return;

    this.setData({ settling: true });
    try {
      const res = await api.call('attendance.settleHistory', { className: this.data.className });
      wx.showModal({ title: '重算完成', content: res.message, showCancel: false });
      await this.loadWeek();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ settling: false });
    }
  },

  async onSettleWeek() {
    const week = this.data.week;
    if (!week || this.data.settling) return;
    if (!week.sessionTotal) {
      util.toast('这一周本班没有组织过考勤');
      return;
    }
    const ok = await util.confirm(
      `将按全勤规则给 ${week.className} 结算 ${week.weekLabel} 的考勤加分：\n\n` +
        `全勤 ${week.fullAttendanceCount} 人，不加分 ${week.noBonusCount} 人，合计 ${week.totalPoints} 分。` +
        (week.isCurrentWeek
          ? '\n\n注意：本周尚未结束，现在结算只统计到目前为止的考勤。之后补了标记可以再结算一次，分数会自动更正。'
          : '\n\n重复结算不会重复加分；改了标记后再结算会自动更正。'),
      '结算考勤加分'
    );
    if (!ok) return;

    this.setData({ settling: true });
    try {
      const res = await api.call('attendance.settleWeek', {
        className: this.data.className,
        weekStart: week.weekStart,
      });
      wx.showModal({ title: '结算完成', content: res.message, showCancel: false });
      await this.loadWeek();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ settling: false });
    }
  },

  /**
   * 班长的名单里包含自己：从中取出本人两场的状态，
   * 既用于出码页签上的「本人打卡」按钮，也用于「我的打卡」页签。
   */
  refreshMyRow() {
    if (!this.data.isMonitor || !this.data.todaySummary) return;
    const me = app.globalData.user;
    const row = this.data.todaySummary.students.find((s) => me && s.studentId === me.studentId);
    if (!row) {
      this.setData({ myRow: null, myStatus: null });
      return;
    }
    const current = this.data.session === 'night' ? row.nightState : row.dayState;
    this.setData({
      myRow: {
        lodgingLabel: row.lodgingLabel,
        currentRequired: current.required !== false,
        currentDone: !!current.checkedIn,
      },
      myStatus: { day: this.data.todaySummary.day, ...decorateSessions(row.sessions) },
    });
  },

  // 班长出码时自己的手机正显示二维码，没法再扫，所以给个按钮。服务端要求这一场正有有效的码
  async onSelfCheckin() {
    if (this.data.selfChecking) return;
    this.setData({ selfChecking: true });
    try {
      const res = await api.call('attendance.selfCheckin', { session: this.data.session });
      util.toast(res.message, 'success');
      await this.loadTodaySummary();
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ selfChecking: false });
    }
  },

  // ============================================================
  // 学生端：扫码打卡
  // ============================================================

  async loadMyStatus() {
    try {
      const status = await api.call('attendance.today', {}, { loading: false });
      // 兼容旧版云函数：没有 sessions 时退回单场次（面授）
      const sessions = status.sessions || [
        { session: 'day', sessionLabel: '面授课', checkedIn: status.checkedIn, timestamp: status.timestamp },
      ];
      this.setData({ myStatus: { day: status.day, ...decorateSessions(sessions) } });
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
      if (this.data.isMonitor) await this.loadTodaySummary();
      else await this.loadMyStatus();
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
