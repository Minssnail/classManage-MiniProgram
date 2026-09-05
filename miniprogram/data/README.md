# 迁移数据快照

本目录的两个模块是**一次性迁移**用的本地数据快照。仓库里只保留空占位内容，
真实数据含学生姓名、手机号、学号，属于个人信息，不入库。

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
