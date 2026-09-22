const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

function stopRefresh() {
  wx.stopPullDownRefresh();
}

// 确认框里最多列出这么多名字，再多就写「等 N 人」
const CONFIRM_NAME_LIMIT = 12;

Page({
  data: {
    scoreTypes: util.SCORE_TYPES,
    typeIndex: 1, // 默认「课堂表现加分」，考勤分由扫码自动产生
    mode: 'single', // single 单人录入 / batch 批量选择
    studentId: '',
    picked: {}, // 批量模式下选中的学号
    pickedCount: 0,
    className: '',
    score: '',
    reason: '',
    submitting: false,

    students: [],
    records: [],
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
    await Promise.all([app.loadCurrentSemester(), app.loadClasses()]);
    const className = app.effectiveClassName() || '';
    // 换了班级，之前勾选的就不是这个班的人了
    if (className !== this.data.className) this.setData({ picked: {}, pickedCount: 0 });
    this.setData({ className });
    await Promise.all([this.loadStudents(), this.loadRecords()]);
  },

  onPullDownRefresh() {
    this.loadRecords().then(stopRefresh, stopRefresh);
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) });
  },

  onMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  onPickStudent(e) {
    this.setData({ studentId: e.currentTarget.dataset.id });
  },

  // ---------- 批量选择 ----------

  setPicked(picked) {
    this.setData({ picked, pickedCount: Object.keys(picked).length });
  },

  onTogglePick(e) {
    const id = e.currentTarget.dataset.id;
    const picked = { ...this.data.picked };
    if (picked[id]) delete picked[id];
    else picked[id] = true;
    this.setPicked(picked);
  },

  onPickAll() {
    const picked = {};
    for (const s of this.data.students) picked[s.studentId] = true;
    this.setPicked(picked);
  },

  onPickNone() {
    this.setPicked({});
  },

  async loadStudents() {
    try {
      const res = await api.call(
        'student.list',
        { semesterId: app.effectiveSemesterId(), className: app.effectiveClassName() || undefined },
        { loading: false, silent: true }
      );
      const students = res.students;
      // 名单刷新后，去掉已经不在名单里的勾选
      const valid = new Set(students.map((s) => s.studentId));
      const picked = {};
      for (const id of Object.keys(this.data.picked)) if (valid.has(id)) picked[id] = true;
      this.setData({ students, picked, pickedCount: Object.keys(picked).length });
    } catch (e) {
      // 学生列表仅用于快捷选择，失败不阻塞单人录入
    }
  },

  async loadRecords() {
    try {
      const res = await api.call(
        'score.list',
        {
          semesterId: app.effectiveSemesterId(),
          className: app.effectiveClassName() || undefined,
          limit: 50,
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
        loaded: true,
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  // 分值与类型两种模式共用
  readScoreForm() {
    const score = Number(this.data.score);
    if (!score) {
      util.toast('请填写非零分值');
      return null;
    }
    return {
      scoreType: this.data.scoreTypes[this.data.typeIndex].value,
      score,
      reason: this.data.reason.trim(),
      semesterId: app.effectiveSemesterId(),
    };
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (this.data.mode === 'batch') this.submitBatch();
    else this.submitSingle();
  },

  async submitSingle() {
    const studentId = this.data.studentId.trim();
    if (!studentId) {
      util.toast('请填写或选择学号');
      return;
    }
    const form = this.readScoreForm();
    if (!form) return;

    this.setData({ submitting: true });
    try {
      await api.call('score.add', { studentId, ...form });
      util.toast('加分成功', 'success');
      this.setData({ score: '', reason: '' });
      await Promise.all([this.loadRecords(), this.loadStudents()]);
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },

  async submitBatch() {
    const ids = this.data.students
      .filter((s) => this.data.picked[s.studentId])
      .map((s) => s.studentId);
    if (!ids.length) {
      util.toast('请先勾选学生');
      return;
    }
    const form = this.readScoreForm();
    if (!form) return;

    // 一次写多条，先让教师看清给了谁、给多少
    const names = this.data.students.filter((s) => this.data.picked[s.studentId]).map((s) => s.name);
    const shown =
      names.length > CONFIRM_NAME_LIMIT
        ? names.slice(0, CONFIRM_NAME_LIMIT).join('、') + ` 等 ${names.length} 人`
        : names.join('、');
    const scoreText = (form.score > 0 ? '+' : '') + form.score;
    const typeLabel = this.data.scoreTypes[this.data.typeIndex].label;
    const ok = await util.confirm(
      `给以下 ${names.length} 名学生各记 ${scoreText} 分（${typeLabel}）：\n\n${shown}` +
        (form.reason ? `\n\n理由：${form.reason}` : ''),
      '批量加分'
    );
    if (!ok) return;

    this.setData({ submitting: true });
    try {
      const res = await api.call('score.addBatch', { studentIds: ids, ...form });
      if (res.failed && res.failed.length) {
        // 极少见：校验通过但个别写入失败，名单留着这几个人，便于重试
        const left = {};
        for (const f of res.failed) left[f.studentId] = true;
        this.setPicked(left);
        wx.showModal({ title: '部分未完成', content: res.message + '\n\n已为你保留这几人的勾选，可直接重试。', showCancel: false });
      } else {
        util.toast(`已给 ${res.count} 人加分`, 'success');
        // 清空勾选，避免连点两次给同一批人重复加分
        this.setData({ score: '', reason: '' });
        this.setPicked({});
      }
      await Promise.all([this.loadRecords(), this.loadStudents()]);
    } catch (e) {
      // 错误提示已在 api 层弹出；整批校验失败时一条都没写，勾选保留
    } finally {
      this.setData({ submitting: false });
    }
  },
});
