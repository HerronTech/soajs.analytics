/* jshint esversion: 6 */
'use strict';
const uuid = require('uuid');
const async = require('async');

const config = require('../config.js');
const colls = {
  analytics: 'analytics',
  environment: 'environment',
};

const utils = {
  buildDeployerOptions(envRecord, soajs, model) {
    const options = {};
    let envDeployer = envRecord.deployer;
    
    if (!envDeployer) return null;
    if (Object.keys(envDeployer).length === 0) return null;
    if (!envDeployer.type || !envDeployer.selected) return null;
    if (envDeployer.type === 'manual') return null;
    
    const selected = envDeployer.selected.split('.');
    
    options.strategy = selected[1];
    options.driver = `${selected[1]}.${selected[2]}`;
    options.env = envRecord.code.toLowerCase();
    
    for (let i = 0; i < selected.length; i++) {
      envDeployer = envDeployer[selected[i]];
    }
    
    options.deployerConfig = envDeployer;
    options.soajs = {registry: soajs.registry};
    options.model = model;
    
    // switch strategy name to follow drivers convention
    if (options.strategy === 'docker') options.strategy = 'swarm';
    
    return options;
  },
  
  getActivatedEnv(settings, currentEnv) {
    let activated = false;
    if (settings && settings.env) {
      const environments = Object.keys(settings.env);
      environments.forEach((oneEnv) => {
        if (oneEnv !== currentEnv) {
          if (settings.env[oneEnv]) {
            activated = true;
          }
        }
      });
    }
    return activated;
  },
  
  addEsClusterToDashboard(soajs, model, dashboard, envRecord, settings, cb) {
    const uid = uuid.v4();
    const es_analytics_db_name = `es_analytics_db_${uid}`;
    const es_analytics_cluster_name = `es_analytics_cluster_${uid}`;
    const es_analytics_cluster = config.elasticsearch.cluster;
    
    if (envRecord.deployer.selected.split('.')[1] === 'kubernetes') {
      // added support for namespace and perService
      let namespace = envRecord.deployer.container.kubernetes[envRecord.deployer.selected.split('.')[2]].namespace.default;
      if (envRecord.deployer.container.kubernetes[envRecord.deployer.selected.split('.')[2]].namespace.perService) {
        namespace += '-soajs-analytics-elasticsearch-service';
      }
      es_analytics_cluster.servers[0].host += `.-service${namespace}`;
    }
    dashboard.dbs.databases[es_analytics_db_name] = {
      cluster: es_analytics_cluster_name,
      tenantSpecific: false,
      usedForAnalytics: true,
    };
    dashboard.dbs.clusters[es_analytics_cluster_name] = es_analytics_cluster;
    
    async.parallel({
      updateDashboard(call) {
        const comboD = {};
        comboD.collection = colls.environment;
        comboD.record = envRecord;
        model.saveEntry(soajs, comboD, call);
      },
      updateSettings(call) {
        const comboS = {};
        comboS.collection = colls.analytics;
        if (!settings) {
          settings = {};
          settings._type = 'settings';
          settings.env = {};
          settings.env[envRecord.code.toLowerCase()] = false;
          settings.elasticsearch = {
            db_name: es_analytics_db_name,
          };
          comboS.record = settings;
          model.insertEntry(soajs, comboS, call);
        } else {
          settings.elasticsearch.db_name = es_analytics_db_name;
          comboS.record = settings;
          model.saveEntry(soajs, comboS, call);
        }
      },
    }, function (err) {
      if (err) {
        return cb(err);
      }
      return cb (null, es_analytics_cluster);
    });
  },
  
  printProgress(soajs, message, counter) {
    if(soajs.log && soajs.log.debug){
      soajs.log.debug(message);
    }
    else{
      console.log(showTimestamp() + ' - ' + message);
    }
    
    function showTimestamp() {
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var now = new Date();
      return '' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getHours() + ':' +
        ((now.getMinutes().toString().length === 2) ? now.getMinutes() : '0' + now.getMinutes()) + ':' +
        ((now.getSeconds().toString().length === 2) ? now.getSeconds() : '0' + now.getSeconds());
    }
  },
};

module.exports = utils;
