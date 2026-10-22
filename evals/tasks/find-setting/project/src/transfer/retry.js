const policy = require("./policy");

async function withRetries(attempt) {
  let lastError;
  for (let i = 0; i < policy.attempts; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, policy.pauseMs * 2 ** i));
    }
  }
  throw lastError;
}

module.exports = { withRetries };