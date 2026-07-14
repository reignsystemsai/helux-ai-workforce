function success(intent, customerSafeMessage, data = {}) {
  return { success: true, intent, customer_safe_message: customerSafeMessage, data, error: null };
}
function failure(intent, code, retryable = false) {
  return { success: false, intent, customer_safe_message: null, data: {}, error: { code, retryable } };
}
module.exports = { success, failure };
