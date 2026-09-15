const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    user: null,
    isTeacher: false,
    displayName: '',
    semesterLabel: '',
    myTotalScore: null,

    passwordVisible: false,
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    submitting: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    await app.loadCurrentSemester();
    const semester = app.effectiveSemester();

    this.setData({
      user,
      isTeacher: user.role === 'teacher',
      displayName:
        user.role === 'student'
          ? util.displayStudent(user.name, user.studentId)
          : user.username,
      semesterLabel: semester ? semester.name : '未设置学期',
      // 学生显示班委角色与住宿情况，班长能从这里知道自己可以协助考勤
      roleLabel:
        user.role === 'teacher'
          ? '教师'
          : [(user.cadreRoleNames || []).join('、') || '学生', user.lodgingLabel]
              .filter(Boolean)
              .join(' · '),
    });

    if (user.role === 'student') {
      try {
        const overview = await api.call(
          'stats.overview',
          { semesterId: app.effectiveSemesterId() },
          { loading: false, silent: true }
        );
        this.setData({ myTotalScore: overview.myTotalScore });
      } catch (e) {
        // 概览失败不影响个人中心其余内容
      }
    }
  },

  onNavigate(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  // ---------- 导入课程与成绩 ----------

  // 课程与成绩数据量大，分批提交避免单次调用超时；服务端按唯一键去重
  async onImportAcademic() {
    const curriculum = require('../../data/curriculum');
    const { majors, courses } = curriculum;
    const { scores } = require('../../data/exam-scores');
    if (!courses.length && !scores.length) {
      wx.showModal({
        title: '没有可导入的数据',
        content: 'data/curriculum.js 或 data/exam-scores.js 还是占位文件。请先在本地用脚本从专业规则与成绩表生成，详见 data/README.md。',
        showCancel: false,
      });
      return;
    }

    const ok = await util.confirm(
      `将导入 ${majors.length} 套专业规则、${courses.length} 门课程、${scores.length} 条考试成绩。\n已导入过的会自动跳过，可以重复执行。`,
      '导入课程与成绩'
    );
    if (!ok) return;

    const CHUNK = 100;
    const batches = [{ majors, courses: courses.slice(0, CHUNK), scores: [] }];
    for (let i = CHUNK; i < courses.length; i += CHUNK) {
      batches.push({ majors: [], courses: courses.slice(i, i + CHUNK), scores: [] });
    }
    for (let i = 0; i < scores.length; i += CHUNK) {
      batches.push({ majors: [], courses: [], scores: scores.slice(i, i + CHUNK) });
    }

    const sum = { majors: 0, courses: 0, scores: 0, skipped: 0 };
    wx.showLoading({ title: '导入中 0%', mask: true });
    try {
      for (let i = 0; i < batches.length; i++) {
        const res = await api.call('academic.import', batches[i], { loading: false });
        sum.majors += res.majors;
        sum.courses += res.courses;
        sum.scores += res.scores;
        sum.skipped += res.skipped;
        wx.showLoading({
          title: '导入中 ' + Math.round(((i + 1) / batches.length) * 100) + '%',
          mask: true,
        });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showModal({
        title: '导入中断',
        content: `已导入课程 ${sum.courses} 门、成绩 ${sum.scores} 条。再次点击可从断点继续。`,
        showCancel: false,
      });
      return;
    }
    wx.hideLoading();

    wx.showModal({
      title: '导入完成',
      content:
        `专业规则 ${sum.majors} 套、课程 ${sum.courses} 门、成绩 ${sum.scores} 条，` +
        `跳过（已存在）${sum.skipped} 条。\n\n` +
        '接下来请到「班级管理」为班级绑定专业规则，课程与成绩查询才能按规则显示。',
      showCancel: false,
    });
  },

  // ---------- 导入 Web 版历史数据 ----------

  // 分批提交，避免单次云函数调用的数据量与耗时过大；已导入的记录服务端会跳过
  async onImportLegacy() {
    // 放在函数内 require，仅在真正导入时才加载这份数据快照
    const legacy = require('../../data/legacy');
    const scoreCount = legacy.scoreRecords.length;
    const rewardCount = legacy.rewards.length;

    const ok = await util.confirm(
      `将把 Web 版的 ${scoreCount} 条积分记录和 ${rewardCount} 条奖励导入云数据库。\n已导入过的会自动跳过，可以重复执行。`,
      '导入历史数据'
    );
    if (!ok) return;

    const CHUNK = 50;
    const batches = [];
    for (let i = 0; i < scoreCount; i += CHUNK) {
      batches.push({ scoreRecords: legacy.scoreRecords.slice(i, i + CHUNK), rewards: [] });
    }
    if (rewardCount) {
      if (batches.length) batches[0].rewards = legacy.rewards;
      else batches.push({ scoreRecords: [], rewards: legacy.rewards });
    }

    const summary = { inserted: 0, skipped: 0, unknownStudent: [], unknownSemester: [] };
    wx.showLoading({ title: '导入中 0%', mask: true });
    try {
      for (let i = 0; i < batches.length; i++) {
        const res = await api.call('system.importLegacy', batches[i], { loading: false });
        summary.inserted += res.inserted;
        summary.skipped += res.skipped;
        summary.unknownStudent = summary.unknownStudent.concat(res.unknownStudent || []);
        summary.unknownSemester = summary.unknownSemester.concat(res.unknownSemester || []);
        wx.showLoading({
          title: '导入中 ' + Math.round(((i + 1) / batches.length) * 100) + '%',
          mask: true,
        });
      }
    } catch (e) {
      wx.hideLoading();
      // 导入是幂等的，失败后重新点击会从未导入的部分继续
      wx.showModal({
        title: '导入中断',
        content: '已成功导入 ' + summary.inserted + ' 条。再次点击「导入历史数据」可从断点继续。',
        showCancel: false,
      });
      return;
    }
    wx.hideLoading();

    let content = '新导入 ' + summary.inserted + ' 条，跳过（已存在）' + summary.skipped + ' 条。';
    const unknownStudent = [...new Set(summary.unknownStudent)];
    const unknownSemester = [...new Set(summary.unknownSemester)];
    if (unknownStudent.length) content += '\n\n以下学号在系统中不存在，已跳过：' + unknownStudent.join('、');
    if (unknownSemester.length) content += '\n\n以下学期不存在，相关记录未归属学期：' + unknownSemester.join('、');

    wx.showModal({ title: '导入完成', content, showCancel: false });
  },

  // ---------- 修改密码 ----------

  onShowPassword() {
    this.setData({
      passwordVisible: true,
      oldPassword: '',
      newPassword: '',
      confirmPassword: '',
    });
  },

  onHidePassword() {
    this.setData({ passwordVisible: false });
  },

  // 阻止浮层内部的点击冒泡到遮罩
  onNoop() {},

  onPasswordInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async onSubmitPassword() {
    const { oldPassword, newPassword, confirmPassword } = this.data;
    if (!oldPassword || !newPassword) {
      util.toast('请填写旧密码和新密码');
      return;
    }
    if (newPassword !== confirmPassword) {
      util.toast('两次输入的新密码不一致');
      return;
    }

    this.setData({ submitting: true });
    try {
      const res = await api.call('auth.changePassword', { oldPassword, newPassword });
      util.toast(res.message, 'success');
      this.setData({ passwordVisible: false });
    } catch (e) {
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ---------- 退出登录 ----------

  async onLogout() {
    const ok = await util.confirm('退出后需要重新输入账号密码登录，确定退出吗？', '退出登录');
    if (!ok) return;
    await app.signOut();
    wx.reLaunch({ url: '/pages/login/index' });
  },
});
