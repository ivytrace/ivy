// Fails at init: the dependency is not installed (Runtime.ImportModuleError).
const leftPad = require('left-pad');

exports.handler = async () => leftPad('x', 3);
