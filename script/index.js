/* jshint esversion: 6 */
'use strict';
const async = require('async');
const step = require('../functions/initialize.js');
const deactivate = require('../functions/deactivate.js');
const utils = require('../utils/utils');
const collection = {
  analytics: 'analytics',
};

let tracker = {};
const script = {
  checkAnalytics(settings, env, cb) {
    const date = new Date().getTime();
    const data = {};
    // return tracker ready
    let activated = false;
    if (settings && settings.env) {
      activated = utils.getActivatedEnv(settings, env);
    }
    if (settings && settings.env && settings.env[env]) {
      if (!(tracker[env] && tracker[env].info && tracker[env].info.status)) {
        tracker[env] = {
          info: {
            status: 'ready',
            ts: date,
          },
        };
        data[env] = true;
        data.tracker = tracker[env];
        data.activated = activated;
      } else {
        data.tracker = tracker[env];
        data[env] = true;
        data.activated = activated;
      }
    } else {
      data.tracker = tracker[env] || {};
      data[env] = false;
      data.activated = activated;
    }
    if (settings) {
      if (settings.kibana) {
        data.kibana = settings.kibana;
      }
      if (settings.elasticsearch) {
        data.elasticsearch = settings.elasticsearch;
      }
    }
    return cb(null, data);
  },
  
  initialize(opts, mode, cb) {
    const data = {};
    const date = new Date().getTime();
    const env = opts.envRecord.code.toLowerCase();
    if (mode === 'dashboard' && opts.settings && opts.settings.env && opts.settings.env[env]) {
      tracker[env] = {
        info: {
          status: 'ready',
          ts: date,
        },
      };
      data[env] = true;
      data.tracker = tracker[env];
      return cb(null, data);
    } else if (mode === 'dashboard' && tracker[env] && tracker[env].info && tracker[env].info.status && tracker[env].info.status === 'started') {
      data.tracker = tracker[env] || {};
      data[env] = false;
      return cb(null, data);
    }
    
    tracker[env] = {
      info: {
        status: 'started',
        ts: date,
      },
    };
    
    function returnTracker() {
      if (mode === 'dashboard') {
        tracker[env] = {
          info: {
            status: 'started',
            ts: date,
          },
        };
        data.tracker = tracker[env];
        data[env] = false;
        return cb(null, data);
      }
    }
    
    returnTracker();
    
    const operations = {
      insertMongoData: async.apply(step.insertMongoData, opts.soajs, opts.model),
      deployElastic: ['insertMongoData', async.apply(step.deployElastic, opts.soajs, opts.config, mode, opts.deployment, opts.envRecord, opts.dashboard, opts.settings, opts.model)],
      pingElasticsearch: ['deployElastic', async.apply(step.pingElasticsearch, opts.soajs, opts.esClient)],
      getElasticClientNode: ['pingElasticsearch', async.apply(step.getElasticClientNode, opts.soajs, opts.esClient, opts.esCluster)],
      setMapping: ['getElasticClientNode', async.apply(step.setMapping, opts.soajs, opts.model, opts.esClient)],
      addVisualizations: ['setMapping', async.apply(step.addVisualizations, opts.soajs, opts.deployment, opts.esClient, opts.envRecord, opts.model)],
      deployKibana: ['addVisualizations', async.apply(step.deployKibana, opts.soajs, opts.config, opts.catalogDeployment, opts.deployment, opts.envRecord, opts.model)],
      deployLogstash: ['deployKibana', async.apply(step.deployLogstash, opts.soajs, opts.config, opts.catalogDeployment, opts.deployment, opts.envRecord, opts.model, opts.esCluster)],
      deployFilebeat: ['deployLogstash', async.apply(step.deployFilebeat, opts.soajs, opts.config, opts.deployment, opts.envRecord, opts.model)],
      deployMetricbeat: ['deployFilebeat', async.apply(step.deployMetricbeat, opts.soajs, opts.config, opts.catalogDeployment, opts.deployment, opts.envRecord, opts.model, opts.esCluster)],
      checkAvailability: ['deployMetricbeat', async.apply(step.checkAvailability, opts.soajs, opts.deployment, opts.envRecord, opts.model)],
      setDefaultIndex: ['checkAvailability', async.apply(step.setDefaultIndex, opts.soajs, opts.deployment, opts.esClient, opts.envRecord, opts.model)],
    };
    
    async.auto(operations, (err, auto) => {
      if (err) {
        if (mode === 'installer') {
          return cb(err);
        }
        return null;
      }
      // close es connection
      if (opts.soajs.inputmaskData && opts.soajs.inputmaskData.elasticsearch === 'local') {
        auto.pingElasticsearch.close();
      }
      else {
        opts.esClient.close();
      }
      console.log('Analytics deployed');
      if (mode === 'installer') {
        return cb(null, true);
      }
      return null;
    });
  },
  
  deactivate(soajs, env, model, cb) {
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    const environment = env.code.toLowerCase();
    model.findEntry(soajs, combo, (err, settings) => {
      if (err) {
        return cb(err);
      }
      const options = utils.buildDeployerOptions(env, soajs, model);
      const activated = utils.getActivatedEnv(settings, environment);
      deactivate.deleteService(options, environment, activated, (error) => {
        if (error) {
          return cb(error);
        }
        if (!settings) {
          tracker = {};
          return cb(null, true);
        }
        
        if (settings.env && settings.env[environment]) {
          settings.env[environment] = false;
        }
        
        if (settings.logstash && settings.logstash[environment]) {
          delete settings.logstash[environment];
        }
        
        if (settings.filebeat && settings.filebeat[environment]) {
          delete settings.filebeat[environment];
        }
        
        if (settings.metricbeat && !activated) {
          delete settings.metricbeat;
        }
        if (settings.kibana && !activated) {
          delete settings.kibana;
        }
        
        // save
        const comboS = {};
        comboS.collection = collection.analytics;
        comboS.record = settings;
        model.saveEntry(soajs, comboS, (error) => {
          if (error) {
            return cb(error);
          }
          tracker = {};
          return cb(null, true);
        });
      });
    });
  },
  
  deployElastic(opts, mode, cb) {
    async.parallel({
      deploy(call) {
        step.deployElastic(opts.soajs, opts.config, mode, opts.dashboard, opts.envRecord, opts.model, null, call);
      },
      updateDb(call) {
        utils.addEsClusterToDashboard(opts.soajs, opts.model, opts.dashboard, opts.envRecord, opts.settings, call);
      },
    }, (err, response) => {
      if (err) {
        return cb(err);
      }
      opts.soajs.log.warn('ELasticsearch has been deployed...');
      return cb(null, response);
    });
  },
  
};

module.exports = script;
