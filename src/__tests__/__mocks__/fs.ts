// Manual mock for fs/promises
export const promises = {
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn()
};

export default {
  promises
};
