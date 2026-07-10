import '@testing-library/jest-dom';

// jsdom does not implement URL.createObjectURL/revokeObjectURL — stub them so
// components that preview a locally-selected File (e.g. the child photo
// upload) don't crash under test.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:mock-object-url';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => undefined;
}
