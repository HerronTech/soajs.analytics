'use strict';
module.exports = {
  env: 'dashboard',
  name: 'soajs-metricbeat',
  variables: [
    // 'ELASTICSEARCH_URL=soajs-analytics-elasticsearch%esNameSpace%:9200' //add support for kubernetes (add namespace)
    // 'ELASTICSEARCH_URL=%elasticsearch_url%'
  ],
  labels: {
    "soajs.content": "true",
    "soajs.service.type": "system",
    "soajs.service.subtype": "metricbeat",
    "soajs.service.name": "soajs-metricbeat",
    "soajs.service.group": "soajs-analytics",
    "soajs.service.label": "soajs-metricbeat",
    "soajs.service.mode": "global"
  },
  command: {
    cmd: ['sh'],
    args: ['-c', 'node index.js -T metricbeat'],
  },
  deployConfig: {
    workDir: '/opt/soajs/deployer',
    image: 'soajstest/metricbeat',
    network: 'soajsnet',
    replication: {
      mode: 'global',
      replicas: 1,
    },
    volume: [{
      Type: 'bind',
      ReadOnly: true,
      Source: 'docker-sock',
      Target: '/var/run/docker.sock',
    }],
    restartPolicy: {
      condition: 'any',
      maxAttempts: 15,
    },
  },
};

