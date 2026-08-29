'use strict';

function createInitializationController(initialize, hooks = {}) {
  let activePromise = null;
  let attempt = 0;

  async function run(trigger = 'unknown') {
    if (activePromise) {
      hooks.onJoin?.({ attempt, trigger });
      return activePromise;
    }

    attempt += 1;
    const currentAttempt = attempt;
    hooks.onStart?.({ attempt: currentAttempt, trigger });

    activePromise = Promise.resolve()
      .then(initialize)
      .then(result => {
        hooks.onSuccess?.({ attempt: currentAttempt, trigger });
        return result;
      })
      .catch(error => {
        hooks.onFailure?.({ attempt: currentAttempt, trigger, error });
        throw error;
      })
      .finally(() => {
        activePromise = null;
        hooks.onFinish?.({ attempt: currentAttempt, trigger });
      });

    return activePromise;
  }

  return {
    run,
    isInitializing: () => Boolean(activePromise),
    getAttempt: () => attempt,
  };
}

module.exports = { createInitializationController };
