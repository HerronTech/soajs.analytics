'use strict';
module.exports = {
  env: '%env%',
  name: '%env%-filebeat',
  variables: [
    'SOAJS_ENV=%env%',
    'SOAJS_LOGSTASH_HOST=%env%-logstash%logNameSpace%',
    'SOAJS_LOGSTASH_PORT=12201',
  ],
  labels: {
    "soajs.content": "true",
    "soajs.service.name": "%env%-filebeat",
    "soajs.service.type": "system",
    "soajs.service.subtype": "filebeat",
    "soajs.service.group": "soajs-analytics",
    "soajs.service.label": "%env%-filebeat",
    "soajs.env.code": "%env%",
    "soajs.service.mode": "global"
  },
  deployConfig: {
    image: 'soajstest/filebeat',
    workDir: '/',
    network: 'soajsnet',
    replication: {
      mode: 'global',
      replicas: 1,
    },
    volume: [
      {
        Type: 'volume',
        ReadOnly: false,
        Source: 'soajs-filebeat',
        Target: '/usr/share/filebeat/bin/data',
      },
      {
        Type: 'volume',
        ReadOnly: false,
        Source: 'soajs-log-volume',
        Target: '/var/log/soajs/',
      }],
    restartPolicy: {
      condition: 'on-failure',
      maxAttempts: 15,
    },
  },
};
