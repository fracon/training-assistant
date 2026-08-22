(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FormState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function isAttachedFitFile(file) {
    return Boolean(
      file &&
      typeof file.name === 'string' &&
      /\.fit$/i.test(file.name)
    );
  }

  function isSubmittable(state) {
    return Boolean(state && isAttachedFitFile(state.file));
  }

  return { isSubmittable, isAttachedFitFile };
});
