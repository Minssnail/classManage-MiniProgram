/**
 * classSE（Web 版）历史数据快照 —— 占位文件
 *
 * 仓库中不保存真实数据：里面是学生学号与积分记录，属于个人信息。
 * 本地迁移时用脚本从 classSE 的 backend/instance/classse.db 生成同名文件覆盖本文件，
 * 再用「我的 → 导入历史数据」导入；导入完成后可恢复为本占位内容。
 *
 * 数据格式见 miniprogram/data/README.md。
 */
module.exports = {
  scoreRecords: [],
  rewards: [],
};
