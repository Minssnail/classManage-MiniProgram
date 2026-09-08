# 迁移数据快照

本目录存放**一次性迁移**用的数据快照。除 `curriculum.js` 外，
仓库里只保留空占位内容——真实数据含学生姓名、手机号、学号，属于个人信息，不入库。

导入完成后可以把它们恢复成占位内容，功能不受影响——导入入口只是读不到数据而已。

## legacy.js —— Web 版历史数据

从 classSE 的 `backend/instance/classse.db` 导出，供「我的 → 导入历史数据」使用。

```js
module.exports = {
  scoreRecords: [
    {
      legacyId: 1,              // 原表主键，云函数据此去重
      studentId: '2000000000001',
      semesterName: '2026年春季学期', // 按名称关联学期
      scoreType: 'attendance',  // attendance/homework/exam/activity/other
      score: 1,
      reason: '课堂考勤打卡',
      operator: 'system',
      timestamp: '2026-03-09T01:42:59.000Z', // UTC，由北京时间换算而来
      day: '2026-03-09',        // 北京时间日期，用于每日去重
    },
  ],
  rewards: [
    {
      legacyId: 1,
      studentId: '2000000000004',
      semesterName: '2026年春季学期',
      rewardType: '一等奖',     // 一等奖/二等奖/三等奖
      reason: '',
      operator: 'teacher',
      timestamp: '2026-03-08T18:00:00.000Z',
      isRedeemed: false,
      redeemedAt: null,
    },
  ],
};
```

注意时间换算：老库把北京时间当作无时区字符串存储，导出时需减去 8 小时得到真实 UTC，
而 `day` 取原字符串的日期部分（即北京日期）。

## curriculum.js —— 专业规则与课程清单

由教学进程表 PDF 与专业规则 xls 导出，供「我的 → 导入课程与成绩」使用。
**不含个人信息，随仓库一起版本管理**，无需本地生成。

```js
module.exports = {
  majors: [
    { ruleCode: '230901308090200', name: '软件工程', level: '本科（高中起点）',
      studentType: '开放', enrollTerm: '2023秋', minCredits: 140, hqExamCredits: 90 },
  ],
  courses: [
    { ruleCode: '230901308090200', order: 21, code: '01507', name: '网络实用技术基础',
      credits: 4, courseType: '统设', courseNature: '必修',
      suggestedTerm: '2', examUnit: '总部',
      level1Module: '专业课', level2Module: '专业基础课' },
  ],
};
```

同一门课在不同规则版本下属性可能不同（例如 `04406 Web开发基础` 在 23 秋规则是「必修(分部)」、
24 秋规则是「选修」），因此课程按 `ruleCode` 分版本存放，班级通过「班级管理 → 专业规则」绑定版本。

## exam-scores.js —— 考试成绩

由各学期考试成绩表导出，含学号，属于个人信息，仓库中只保留占位内容。

```js
module.exports = {
  scores: [
    {
      term: '2023秋',
      courseCode: '01507',
      courseName: '网络实用技术基础',
      paperNo: '22379',
      studentId: '2000000000123',
      formRatio: 50,        // 形考比例(%)
      formScore: 96,        // 形考成绩
      finalScore: 51,       // 终考成绩
      totalScore: 0,        // 综合成绩
      dualRequired: true,   // 该课程是否要求终考与综合双双及格
      status: '无效',       // 及格 / 不及格 / 无效
    },
  ],
};
```

`dualRequired` 对应原表的「是否双及格（终考 + 综合）」，含义是**该课程是否执行双及格规则**，
不是「两项都及格了」。执行该规则的课程终考不足 60 分时，综合成绩记 0、状态判为「无效」。

## roster.js —— 班级名册

从名册 xlsx 导出，供「我的 → 班级管理 → 导入名册」使用。

```js
module.exports = {
  className: '26秋计算机网络技术班',
  students: [
    { name: '张三', phone: '13800138000' },  // 新生未分配学号，以手机号登录
    { name: '李四', studentId: '2644101360001', phone: '13800138001' }, // 已有学号
  ],
};
```

`studentId` 与 `phone` 至少给一个。只给手机号时，学生以手机号登录，
系统标记为「待分配学号」，学号下发后在学生管理里补录即可。

两个导入接口都按原始标识去重，重复导入不会产生副本，中断后重新导入会从断点继续。
