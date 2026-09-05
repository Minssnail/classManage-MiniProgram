/**
 * 云函数调用封装：统一加载态、错误提示与返回值解包。
 *
 * 业务错误由云函数以 { ok:false, error } 返回，这里转成 reject，
 * 调用方 try/catch 即可；默认会自动弹一次 toast 提示。
 */
const FUNCTION_NAME = 'classmanage';

let loadingCount = 0;

function showLoading(title) {
  loadingCount++;
  if (loadingCount === 1) wx.showLoading({ title: title || '加载中', mask: true });
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) wx.hideLoading();
}

/**
 * @param {string} action 云函数动作名，如 'score.list'
 * @param {object} [payload] 业务参数
 * @param {object} [options] { loading, loadingText, silent }
 * @returns {Promise<object>} 云函数返回的 data
 */
function call(action, payload, options) {
  const opts = Object.assign({ loading: true, silent: false }, options || {});
  if (opts.loading) showLoading(opts.loadingText);

  return wx.cloud
    .callFunction({ name: FUNCTION_NAME, data: Object.assign({ action }, payload || {}) })
    .then((res) => {
      const result = res && res.result;
      if (!result) throw new Error('云函数无返回值');
      if (!result.ok) throw new Error(result.error || '操作失败');
      return result.data;
    })
    .then(
      (data) => {
        if (opts.loading) hideLoading();
        return data;
      },
      (err) => {
        if (opts.loading) hideLoading();
        // 云函数未部署或网络异常时，errMsg 往往更有指向性
        const message = err && (err.message || err.errMsg) ? err.message || err.errMsg : '网络异常';
        if (!opts.silent) {
          wx.showToast({ title: message, icon: 'none', duration: 2500 });
        }
        throw new Error(message);
      }
    );
}

module.exports = { call, FUNCTION_NAME };
