# 班级积分管理系统（微信小程序 · 云开发）

由 Web 版班级积分管理系统（`classSE`，Flask + 单页前端）重构而来，改为微信小程序 + 云开发架构。
业务功能保持一致：学生管理、积分记录、奖励发放与兑换、学期管理、统计分析；
**考勤打卡改为「教师端出示短效二维码 → 学生现场扫码」，学生无法自行打卡。**

## 一、目录结构

```
miniprogram/
  app.js / app.json / app.wxss     入口、路由与 tabBar、全局样式
  config.js                        云开发环境 ID 配置
  utils/
    api.js                         云函数调用封装（加载态 / 错误提示 / 解包）
    qrcode.js                      内置二维码编码器（无第三方依赖）
    util.js                        常量、时间格式化、加分说明
  pages/
    login/                         登录（学号 / 手机号 / 教师账号）
    dashboard/                     系统概况（tab）：班级与学期切换、概览、排行榜、加分说明
    attendance/                    考勤（tab）：教师出码 / 学生扫码
    query/                         查询（tab）：积分记录、奖励记录
    profile/                       我的（tab）：账号信息与管理入口
    classes/ students/ score-manage/ rewards/ semesters/    教师端管理页
    statistics/                    统计分析（近 7 天趋势、类型占比）
  data/
    legacy.js                      Web 版历史数据快照（导入后可删）
    roster.js                      班级名册快照（导入后可删）
cloudfunctions/
  classmanage/                     全部业务逻辑（单云函数 + action 路由）
```

## 二、部署步骤

1. **填写环境 ID**：微信开发者工具右上角「云开发」面板复制环境 ID，填入 `miniprogram/config.js` 的 `cloudEnv`；
   若小程序只绑定了一个云环境，留空即可使用默认环境。
2. **部署云函数**：在开发者工具中右键 `cloudfunctions/classmanage` →「上传并部署：云端安装依赖」。
3. **初始化数据**：云开发控制台 → 云函数 → `classmanage` → 云端测试，传入
   `{"action": "system.init"}` 并执行。该操作会创建全部数据库集合并写入种子数据，
   **幂等**，不会覆盖已有数据。首次执行（库中还没有任何账号）无需登录态，之后仅教师可执行。
4. **设置数据库权限**：云开发控制台 → 数据库 → 逐个集合把权限设为
   **「仅管理端可读写」**（`users` / `students` / `classes` / `semesters` / `scoreRecords` / `rewards` / `attendanceCodes`）。
   小程序端不直接读写数据库，全部经由云函数，因此关闭客户端权限不影响功能，且能杜绝前端刷分。

初始账号：

| 角色 | 登录账号 | 初始密码 |
| --- | --- | --- |
| 教师 | `teacher` | 初始化时随机生成，见 `system.init` 的返回结果 |
| 学生（已有学号） | 学号，如 `2000000000001` | `student` |
| 学生（新生未分配学号） | 手机号，如 `13800138000` | `student` |

教师密码只在初始化那一次的返回结果里出现，请当场记下并在登录后修改。
初始化只创建三名示例学生用于验证环境，真实名单请用「班级管理 → 导入名册」或
「学生管理 → 添加学生」录入——姓名、学号属于个人信息，不写进代码。

登录成功后，该微信号会与账号绑定，下次进入自动登录；「我的 → 退出登录」可解绑。
学号与手机号是同一个账号的两个登录入口，学号补录后两者都能继续登录。

学生自行改过密码又忘记时无法自助找回，由教师在「学生管理」里点该生的「重置密码」处理：
密码恢复为 `student`，同时解除微信绑定，学生换手机或账号被别人登录过都能重新登入。

## 三、班级

一位教师可以带多个班级，全系统的数据都按班级隔离。

- **班级切换**：教师在「概况」页顶部切换当前班级，概况、排行榜、考勤、积分、奖励、统计都会随之切换作用域。
- **学生视角**：学生锁定在自己所在班级，看不到其他班级的任何数据（服务端强制，改请求参数也无效）。
- **考勤二维码绑定班级**：二维码带班级信息，其他班级的学生扫码会被拒绝。
- **班级管理**：「我的 → 班级管理」可新建、重命名、删除班级（仅限没有学生的班级），并导入随包携带的名册。

### 入学学期

每个班级有一个「入学学期」，入学之前的学期与该班无关，因此：

- 该班的学期切换里不会出现入学之前的学期（26 秋入学的新生看不到 26 春学期）；
- 入学之前的积分、奖励记录不会计入该班的概况、排行榜与查询结果，
  转班学生带过来的旧记录同样不会混进新班的视图。

新建班级和导入名册时默认以当前学期为入学学期；在「班级管理 → 入学学期」里可以改，
也可以设为「不限制」以查看全部学期。老班级（升级前已存在的）默认不限制，行为与之前一致。

过滤在服务端完成：学生传入的 `className`、`semesterId` 都会按本人所在班级的入学学期重新裁剪。

### 新生没有学号怎么办

刚入学的新生学校还没下发学号，系统以手机号作为登录账号和内部关联键，
学生记录标记 `studentIdAssigned: false`，界面显示「待分配学号」而不是把手机号当学号展示。

学号下发后，在「学生管理」里点该生的「补录学号」，服务端会在一次操作中：

1. 更新学生档案的学号并标记为已分配；
2. 把账号的用户名换成学号（手机号字段保留，仍可登录）；
3. 把该生名下的全部积分、奖励记录迁移到新学号。

因此补录不会丢失任何历史数据，补录后学号和手机号都能登录。

## 四、扫码考勤的设计

Web 版允许学生点「我要打卡」自行打卡，容易缺勤代打。小程序版改为二维码考勤：

**教师端**（考勤 tab）

1. 选择有效期（30 秒 / 60 秒 / 2 分钟 / 5 分钟，默认 60 秒）并生成二维码；
2. 二维码在页面上倒计时，到期后可自动刷新（默认开启），也可「立即失效」；
3. 下方实时显示本次二维码的扫码名单，以及今日全班考勤情况，未打卡的学生可一键补录。

**学生端**（考勤 tab）

1. 点击「扫码打卡」，调起摄像头扫描教师出示的二维码；
2. 打卡成功记考勤加分 1 分，每人每天限一次。

**防作弊要点**

- 打卡凭据是服务端随机生成的 128 位令牌（`CLASSMANAGE_ATT:<32 位十六进制>`），客户端无法伪造；
- 令牌短效，过期即失效；教师每次生成新码时，自动作废该教师此前未过期的旧码，旧截图立刻作废；
- 学生端 `wx.scanCode` 使用 `onlyFromCamera: true`，无法从相册选取二维码截图；
- 有效期倒计时以服务端时间为基准换算，手机改系统时间无效；
- 打卡身份取自微信 `OPENID`（云函数上下文提供，不可伪造），学生只能给自己打卡；
- 每人每天一次的去重按北京时间日期在服务端判定。

「学生自行打卡」的入口已彻底移除：`attendance.checkin` 必须携带有效令牌才会写入考勤记录，
补录接口 `attendance.manualCheckin` 则要求教师权限。

## 五、待补考与待修读

某门课的历次考试都没及格就计入待补考，**必修选修都算**——挂掉的选修课一样要重修。

「统设必修课 / 全部课程」这个口径切换只作用于**平均分**，不作用于待补考名单，
否则挂掉的统设选修课会被口径过滤掉、看不到也报不了名。云函数的
`exam.pending`、`exam.exportRetake` 仍支持 `requiredOnly` 参数，但页面不再传。

学生在「成绩查询 → 待补考」里勾选本次要报考的科目并提交，教师导出时可选
「学生已选版」或「全部待补考版」。补考通过后该门课自动离开名单，选课记录随之失效。

待补考名单、学生选课校验与导出三处共用同一个 `computePending`，避免口径分叉。

### 待修读

「课程信息」页另有一份**待修读**名单：本人适用的规则里学校实际开设、但一次都没考过的课程。

| | 判定 | 在哪里处理 |
| --- | --- | --- |
| 待补考 | 考过，但历次都没及格 | 成绩查询 → 待补考，学生勾选后教师「导出补考表」 |
| 待修读 | 计划内、一次都没考过 | 课程信息 → 教师「导出待修读选课表」 |

两者互不重叠，合起来就是学生离毕业还差的全部课程。

**课程范围按规则版本各自认定**，以学校的教学进程表为准，而不是整份专业规则：

| 规则版本 | 计划课程 | 实际开设 | 依据 |
| --- | --- | --- | --- |
| 230901308090200（23 秋） | 52 | 40 | 《23秋软件工程专业教学进程表(待修读)》 |
| 240901308090200（24 秋） | 39 | 39 | 《2024秋季开放本科(高中起点)软件工程-专业规则》 |

23 秋有 12 门选修（商务英语系列、区块链技术、软件数学基础等）学校没有开设，
课程清单里保留但标 `offered: false`，不计入待修读。这个字段是后加的，
老库里的课程记录会在下次 `academic.import` 时补写，没有该字段的一律当作已开设。

导出的 xlsx 有两张表：第一张按学校《批量导入选课记录》模板，可直接导入教务；
第二张「待修读明细」保留教学进程表的模块、学分、建议开设学期与考试单位，供教师核对。

## 六、数据库集合

| 集合 | 说明 | 主要字段 |
| --- | --- | --- |
| `users` | 账号 | `username`、`phone`、`passwordSalt`、`passwordHash`、`role`、`studentId`、`openid` |
| `students` | 学生 | `name`、`studentId`、`studentIdAssigned`、`phone`、`className` |
| `classes` | 班级 | `name`、`createdBy`、`isArchived` |
| `semesters` | 学期 | `name`、`startDate`、`endDate`、`isCurrent`、`isArchived` |
| `scoreRecords` | 积分记录 | `studentId`、`semesterId`、`scoreType`、`score`、`reason`、`operator`、`timestamp`、`day`、`codeId` |
| `rewards` | 奖励 | `studentId`、`semesterId`、`rewardType`、`certificateImage`、`isRedeemed`、`redeemedAt` |
| `attendanceCodes` | 考勤二维码 | `token`、`ttl`、`className`、`expireAt`、`day`、`revoked`、`checkinCount`、`createdBy` |

密码使用 PBKDF2-SHA256（10000 轮，每账号独立盐）存储，云函数内校验时做定长比较。
积分记录额外冗余一个北京时间日期字段 `day`，用于「今日」判定与每日去重，避免云函数 UTC 时区带来的偏差。

## 七、云函数接口

统一入口：`wx.cloud.callFunction({ name: 'classmanage', data: { action, ...payload } })`，
返回 `{ ok: true, data }` 或 `{ ok: false, error }`。

| 分类 | action |
| --- | --- |
| 系统 | `system.init`、`system.importLegacy`、`system.legacyStatus` |
| 认证 | `auth.login`、`auth.me`、`auth.logout`、`auth.changePassword` |
| 班级 | `class.list`、`class.create`、`class.rename`、`class.remove`、`class.setStartSemester`、`class.importRoster` |
| 学生 | `student.list`、`student.add`、`student.assignStudentId`、`student.resetPassword`、`student.setRule` |
| 课程成绩 | `academic.import`、`major.list`、`course.list`、`course.todo`、`course.exportTodo`、`exam.list`、`exam.summary`、`exam.pending`、`exam.exportRetake` |
| 补考选课 | `retake.select`、`retake.submit` |
| 积分 | `score.add`、`score.list` |
| 考勤 | `attendance.createCode`、`attendance.codeStatus`、`attendance.revokeCode`、`attendance.checkin`、`attendance.manualCheckin`、`attendance.today` |
| 奖励 | `reward.add`、`reward.list`、`reward.redeem`、`reward.unredeem` |
| 统计 | `stats.overview`、`stats.ranking`、`stats.trend` |
| 学期 | `semester.list`、`semester.current`、`semester.create`、`semester.setCurrent`、`semester.archive`、`semester.remove` |

权限在服务端判定：教师可管理全部数据；学生可查看**本班**的积分记录（沿用 Web 版的互相监督设定，
但范围收窄到本班），奖励记录只能看自己的，所有写操作（加分、发奖、建班级、建学期等）一律拒绝。
学生传入的 `className` 参数会被服务端忽略并强制改回本人所在班级。

## 八、与 Web 版的功能对照

| Web 版 | 小程序版 | 说明 |
| --- | --- | --- |
| 系统概况 | 概况 tab | 概览卡片、积分类型分布、排行榜、加分说明 |
| 考勤打卡（学生自助） | 考勤 tab | **改为教师出码 + 学生扫码**，另提供教师补录 |
| 积分管理 | 我的 → 积分管理 | 加分表单支持点选学生，支持负分扣分 |
| 学生管理 | 我的 → 学生管理 | 新增学生时同步创建账号，支持无学号的新生与学号补录 |
| （无） | 我的 → 班级管理 | **新增**：一位教师带多个班级，数据按班级隔离 |
| 积分查询 / 奖励查询 | 查询 tab | 两个子标签，支持按学号与类型筛选 |
| 奖励管理 | 我的 → 奖励管理 | 发奖、奖券预览、兑换 / 取消兑换 |
| 统计分析（ECharts） | 我的 → 统计分析 | 改用原生绘制的条形图，不引入图表库 |
| 学期管理 | 我的 → 学期管理 | 建学期、设为当前、存档、删除 |
| 学期只读浏览 | 概况 tab 顶部切换 | 浏览历史学期时禁用考勤打卡并给出提示 |

图表未沿用 ECharts：小程序引入图表库需要 npm 构建，且体积可观，改为用 WXSS 直接绘制条形图与趋势柱状图。
二维码同样没有引入第三方库，`utils/qrcode.js` 是内置实现（字节模式 / 纠错等级 L / 版本 1~9），
已与 `qrcode` 参考实现逐位比对验证一致。
