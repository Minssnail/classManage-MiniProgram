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

    // 待修读：本人（教师则为全班）适用规则里还没修读过的课程
    isTeacher: false,
    todo: null,
    todoList: [],
    todoOpen: false,
    exporting: false,
  },

  async onShow() {
    const user = await app.requireUser();
    if (!user) return;
    this.setData({ isTeacher: app.isTeacher() });
    await app.loadClasses();
    await Promise.all([this.loadCourses(), this.loadTodo()]);
  },

  onPullDownRefresh() {
    const done = () => stopRefresh();
    Promise.all([this.loadCourses(), this.loadTodo()]).then(done, done);
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

  async loadTodo() {
    try {
      const res = await api.call(
        'course.todo',
        { className: app.effectiveClassName() || undefined },
        { loading: false }
      );
      this.setData({
        todo: res,
        todoList: (res.todo || []).map((c) => ({
          ...c,
          rowKey: c.studentId + '|' + c.courseCode,
          termText: c.suggestedTerm ? '第 ' + c.suggestedTerm + ' 学期' : '',
        })),
      });
    } catch (e) {
      this.setData({ todo: null, todoList: [] });
    }
  },

  onToggleTodo() {
    this.setData({ todoOpen: !this.data.todoOpen });
  },

  onExplainTodo() {
    wx.showModal({
      title: '什么算待修读',
      content:
        '本人适用的专业规则里，学校实际开设、但一次都没考过的课程。\n\n' +
        '考过没及格的不在这里，属于重修，在「成绩查询 → 待补考」里报名。\n\n' +
        '课程范围按各自的规则版本：23 秋按教学进程表列出的 40 门（完整计划 52 门里' +
        '有 12 门选修未开设），24 秋按专业规则的 39 门。',
      showCancel: false,
    });
  },

  /**
   * 导出待修读选课表：第一张表按学校《批量导入选课记录》模板可直接导入，
   * 第二张表保留教学进程表的模块与建议开设学期，供教师核对。
   */
  async onExportTodo() {
    if (this.data.exporting) return;
    const todo = this.data.todo;
    if (!todo || !todo.total) return;

    const choice = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: [
          `全部待修读（${todo.total} 条）`,
          `只导统设必修（${todo.requiredTotal} 条）`,
        ],
        success: (res) => resolve(res.tapIndex),
        fail: () => resolve(-1),
      });
    });
    if (choice < 0) return;
    const requiredOnly = choice === 1;

    const ok = await util.confirm(
      `将导出${requiredOnly ? '统设必修的' : '全部'}待修读课程，` +
        '第一张表对齐学校的「批量导入选课记录」模板，第二张表附教学进程表明细。',
      '导出待修读选课表'
    );
    if (!ok) return;

    this.setData({ exporting: true });
    wx.showLoading({ title: '生成中', mask: true });
    try {
      const res = await api.call(
        'course.exportTodo',
        { className: app.effectiveClassName() || undefined, requiredOnly },
        { loading: false }
      );
      wx.showLoading({ title: '下载中', mask: true });
      const file = await wx.cloud.downloadFile({ fileID: res.fileID });
      wx.hideLoading();

      let tip = `已生成 ${res.rowCount} 条选课记录，涉及 ${res.studentCount} 名学生，` +
        `合计 ${res.todoCredits} 学分。`;
      if (res.missingStudentId && res.missingStudentId.length) {
        tip +=
          '\n\n以下学生尚未分配学号，模板要求填身份证，系统里没有该字段，' +
          '学号列已留空，请在表格中手动补齐：' +
          res.missingStudentId.join('、');
      }
      tip += '\n\n接下来会打开表格，可通过右上角菜单转发或用其他应用保存。';

      wx.showModal({
        title: '导出成功',
        content: tip,
        showCancel: false,
        success: () => {
          wx.openDocument({
            filePath: file.tempFilePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: () => util.toast('打开表格失败，请稍后重试'),
          });
        },
      });
    } catch (e) {
      wx.hideLoading();
      // 错误提示已在 api 层弹出
    } finally {
      this.setData({ exporting: false });
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
