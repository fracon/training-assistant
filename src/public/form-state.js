(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FormState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function isSubmittable(state) {
    return Boolean(
      state &&
      Number.isInteger(state.rpe) &&
      state.rpe >= 1 &&
      state.rpe <= 10 &&
      typeof state.notes === 'string' &&
      state.notes.trim().length > 0 &&
      state.file
    );
  }

  return { isSubmittable };
});
