/* jshint esversion: 6 */
'use strict';
const deployer = require('soajs.core.drivers');
const async = require('async');

const lib = {
  /**
   * delete analytics services
   * @param {object} options: object for deployer
   * @param {object} env: environment object
   * @param {boolean} activated: check if other env have analytics avtivated
   * @param {function} cb: callback function
   */
  deleteService(options, env, activated, cb) {
    deployer.listServices(options, (error, services) => {
      if (!services) services = [];
      // loop over services
      // delete kibana, logstash, filebeat, and metric beat
      async.eachSeries(services, (oneService, callback) => {
        // add check if another environment have analytics activated
        // if activated do not remove kibana or metricbeat
        if (oneService.labels['soajs.service.group'] === 'soajs-analytics'
          && oneService.labels['soajs.service.name'] !== 'soajs-analytics-elasticsearch') {
          if (activated && ((oneService.labels['soajs.service.name'] === 'soajs-metricbeat') ||
            oneService.labels['soajs.service.name'] === 'soajs-kibana')) {
            return callback(null, true);
          } else if (oneService.labels['soajs.env.code'] === env || oneService.labels['soajs.service.name'] === 'soajs-kibana' || oneService.labels['soajs.service.name'] === 'soajs-metricbeat') {
            options.params = {
              id: oneService.id,
              mode: oneService.labels['soajs.service.mode'], // NOTE: required for kubernetes driver only
            };
            deployer.deleteService(options, callback);
          } else {
            return callback(null, true);
          }
        } else {
          return callback(null, true);
        }
      }, cb);
    });
  },
};
module.exports = lib;
