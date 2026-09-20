'use strict';

let authorizationEpoch = 0;

function markAuthorizationChanged() {
  authorizationEpoch += 1;
  return authorizationEpoch;
}

function getAuthorizationEpoch() {
  return authorizationEpoch;
}

module.exports = {
  markAuthorizationChanged,
  getAuthorizationEpoch
};
