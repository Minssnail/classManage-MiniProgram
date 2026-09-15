/**
 * 公共常量与格式化工具
 */

const SCORE_TYPES = [
  { value: 'attendance', label: '考勤加分' },
  { value: 'homework', label: '课堂表现加分' },
  { value: 'exam', label: '作业或考核加分' },
  { value: 'activity', label: '课余活动加分' },
  { value: 'other', label: '其他加分' },
];

const SCORE_TYPE_LABELS = SCORE_TYPES.reduce((map, item) => {
  map[item.value] = item.label;
  return map;
}, {});

const REWARD_TYPES = ['一等奖', '二等奖', '三等奖'];

// 积分明细的类型标签。晚修打卡也是一条考勤记录，但单独统计、不计入总积分，要标出来
function recordTypeLabel(record) {
  if (record && record.countsTowardTotal === false) return '晚修考勤 · 不计入总积分';
  return SCORE_TYPE_LABELS[record && record.scoreType] || (record && record.scoreType) || '';
}

// 加分说明（与 Web 版规则保持一致）
const BONUS_RULES = [
  {
    title: '1、考勤加分',
    detail:
      '一周内全勤加3分，请假一天加2分，请假两天加1分。凡迟到早退2次及以上、无故缺勤等异常情况不加分。' +
      '晚修考勤加分单独统计，不计入总积分。',
  },
  {
    title: '2、课堂表现加分',
    detail:
      '积极融入课堂等行为（主动回答有难度的问题加1分/次，按时完成课堂任务加1分/项（课程结束一周内补交加0.5分/项），主动发现问题及其原因加2分/项，主动思考并提出问题的解决方法加2分/项）。',
  },
  {
    title: '3、课余活动加分',
    detail:
      '班级活动（观看拍照、值日卫生、户外活动等）加1分/次，参加校园比赛加3分/项（获奖额外加分：校级1分、市级3分、省级6分、国家级10分），参加学科竞赛或科研项目加10分/项（获奖按前述级别额外加分）。',
  },
  {
    title: '4、作业或学业成绩加分',
    detail:
      '按时完成课程作业加1分/项（课程结束一周内补交加0.5分/项），作业完成优秀加3分/次，学习小组组长表现优秀加3分/月。通过学期正考的双及格专业课程加8分/门，补考的加5分/门。',
  },
  {
    title: '5、其他加分',
    detail:
      '班委任职表现良好加8分/学期，参评学校优秀学生或干部加5分/次（获评额外加分：校区级1分、市省级3分、国家级5分）。以及其他值得加分的表现，如获得表彰按第三项所述的级别加分。',
  },
];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 云数据库返回的时间可能是 Date、时间戳或 ISO 字符串
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return (
    d.getFullYear() +
    '-' + pad2(d.getMonth() + 1) +
    '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) +
    ':' + pad2(d.getMinutes())
  );
}

function formatDate(value) {
  const d = toDate(value);
  if (!d) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function formatTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function today() {
  return formatDate(new Date());
}

// 学生显示为「姓名（学号）」，缺姓名时退回学号
function displayStudent(name, studentId) {
  if (name && studentId) return name + '（' + studentId + '）';
  return name || studentId || '';
}

function toast(title, icon) {
  wx.showToast({ title, icon: icon || 'none', duration: 2000 });
}

function confirm(content, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '提示',
      content,
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
}

module.exports = {
  recordTypeLabel,
  SCORE_TYPES,
  SCORE_TYPE_LABELS,
  REWARD_TYPES,
  BONUS_RULES,
  formatDate,
  formatDateTime,
  formatTime,
  today,
  displayStudent,
  toast,
  confirm,
};
