'use strict';
module.exports = {
  env: '%env%',
  name: '%env%-logstash',
  variables: [
    // 'ELASTICSEARCH_URL=soajs-analytics-elasticsearch%esNameSpace%:9200'
    // 'ELASTICSEARCH_URL=%elasticsearch_url%'
  ],
  labels: {
    "soajs.content": "true",
    "soajs.env.code": "%env%",
    "soajs.service.type": "system",
    "soajs.service.subtype": "logstash",
    "soajs.service.name": "%env%-logstash",
    "soajs.service.group": "soajs-analytics",
    "soajs.service.label": "%env%-logstash",
    "soajs.service.mode": "replicated"
  },
  command: {
    cmd: ['bash'],
    args: ['-c', 'node index.js -T logstash'],
  },
  deployConfig: {
    image: 'soajstest/logstash',
    workDir: '/opt/soajs/deployer',
    network: 'soajsnet',
    ports: [
      {
        isPublished: false,
        published: 12201,
        target: 12201,
      },
    ],
    replication: {
      mode: 'replicated',
      replicas: 1,
    },
    restartPolicy: {
      condition: 'any',
      maxAttempts: 15,
    },
  },
};
