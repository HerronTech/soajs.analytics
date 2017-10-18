'use strict';

var defaultVoluming = {}, mongoVoluming = {}, esVoluming = {}, dockerSocketVoluming = {};
if (process.env.SOAJS_DEPLOY_HA === 'docker') {
  defaultVoluming = {
    "volumes": [
      {
        "Type": "volume",
        "Source": "soajs-log-volume",
        "Target": "/var/log/soajs/"
      },
      //NOTE: Voluming the unix socket is only required for the controller
      //NOTE: It is not required for any other service and can be removed
      {
        "Type": "bind",
        "ReadOnly": true,
        "Source": "/var/run/docker.sock",
        "Target": "/var/run/docker.sock"
      }
    ]
  };
  mongoVoluming = {
    "volumes": [
      {
        "Type": "volume",
        "Source": "/data/custom/db/",
        "Target": "/data/db/"
      }
    ]
  };
  esVoluming = {
    "volumes": [
      {
        "Type": "volume",
        "Source": "/usr/share/elasticsearch/custom/data/",
        "Target": "/usr/share/elasticsearch/data/"
      }
    ]
  };
  dockerSocketVoluming = {
    "volumes": [
      {
        "Type": "bind",
        "ReadOnly": true,
        "Source": "/var/run/docker.sock",
        "Target": "/var/run/docker.sock"
      }
    ]
  };
}
else if (process.env.SOAJS_DEPLOY_HA === 'kubernetes') {
  defaultVoluming = {
    "volumes": [
      {
        "name": "soajs-log-volume",
        "hostPath": {
          "path": "/var/log/soajs/"
        }
      }
    ],
    "volumeMounts": [
      {
        "mountPath": "/var/log/soajs/",
        "name": "soajs-log-volume"
      }
    ]
  };
  mongoVoluming = {
    "volumes": [
      {
        "name": "custom-mongo-volume",
        "hostPath": {
          "path": "/data/custom/db/"
        }
      }
    ],
    "volumeMounts": [
      {
        "mountPath": "/data/db/",
        "name": "custom-mongo-volume"
      }
    ]
  };
  esVoluming = {
    "volumes": [
      {
        "name": "custom-es-volume",
        "hostPath": {
          "path": "/usr/share/elasticsearch/custom/data/"
        }
      }
    ],
    "volumeMounts": [
      {
        "mountPath": "/usr/share/elasticsearch/data/",
        "name": "custom-es-volume"
      }
    ]
  };
  dockerSocketVoluming = {
    "volumes": [
      {
        "name": "docker-sock",
        "hostPath": {
          "path": "/var/run/docker.sock"
        }
      }
    ],
    "volumeMounts": [
      {
        "mountPath": "/var/run/docker.sock",
        "name": "docker-sock"
      }
    ]
  };
}

var catalogs = [
  {
    "name": "Metricbeat Recipe",
    "type": "system",
    "subtype": "metricbeat",
    "locked": true,
    "description": "This is a sample metricbeat recipe",
    "recipe": {
      "deployOptions": {
        "image": {
          "prefix": "soajstest",
          "name": "metricbeat",
          "tag": "latest",
          "pullPolicy": "IfNotPresent"
        },
        "labels": {
          "soajs__dot__service__dot__group": "soajs-analytics"
        },
        "container": {
          "network": "",
          "workingDir": "/opt/soajs/deployer"
        },
        "voluming": JSON.parse(JSON.stringify(dockerSocketVoluming))
      },
      "buildOptions": {
        "env": {
          "SOAJS_ANALYTICS_ES_NB": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_NB"
          },
          "SOAJS_ANALYTICS_ES_IP": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_IP_N"
          },
          "SOAJS_ANALYTICS_ES_PORT": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_PORT_N"
          },
          "SOAJS_ANALYTICS_ES_USERNAME": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_USERNAME"
          },
          "SOAJS_ANALYTICS_ES_PASSWORD": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_PASSWORD"
          }
        },
        "cmd": {
          "deploy": {
            "command": [
              "sh",
              "-c"
            ],
            "args": [
              "node index.js -T metricbeat"
            ]
          }
        }
      }
    }
  },
  {
    "name": "Logstash Recipe",
    "type": "system",
    "subtype": "logstash",
    "locked": true,
    "description": "This is a sample logstash recipe",
    "recipe": {
      "deployOptions": {
        "image": {
          "prefix": "soajstest",
          "name": "logstash",
          "tag": "latest",
          "pullPolicy": "IfNotPresent"
        },
        "labels": {
          "soajs__dot__service__dot__group": "soajs-analytics"
        },
        "container": {
          "network": "",
          "workingDir": "/opt/soajs/deployer"
        },
        "voluming": {
          "volumes": [],
          "volumeMounts": []
        },
        "ports": [
          {
            "name": "logstash",
            "isPublished": false,
            "target": 12201
          }
        ]
      },
      "buildOptions": {
        "env": {
          "SOAJS_ANALYTICS_ES_NB": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_NB"
          },
          "SOAJS_ANALYTICS_ES_IP": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_IP_N"
          },
          "SOAJS_ANALYTICS_ES_PORT": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_PORT_N"
          },
          "SOAJS_ANALYTICS_ES_USERNAME": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_USERNAME"
          },
          "SOAJS_ANALYTICS_ES_PASSWORD": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_PASSWORD"
          }
        },
        "cmd": {
          "deploy": {
            "command": [
              "bash",
              "-c"
            ],
            "args": [
              "node index.js -T logstash"
            ]
          }
        }
      }
    }
  },
  {
    "name": "Kibana Recipe",
    "type": "system",
    "subtype": "kibana",
    "locked": true,
    "description": "This is a sample kibana recipe",
    "recipe": {
      "deployOptions": {
        "image": {
          "prefix": "soajstest",
          "name": "kibana",
          "tag": "latest",
          "pullPolicy": "IfNotPresent"
        },
        "container": {
          "network": "",
          "workingDir": "/opt/soajs/deployer"
        },
        "voluming": {
          "volumes": [],
          "volumeMounts": []
        },
        "labels": {
          "soajs__dot__service__dot__group": "soajs-analytics"
        },
        "ports": [
          {
            "name": "kibana",
            "isPublished": true,
            "target": 5601,
            "published": 32601
          }
        ]
      },
      "buildOptions": {
        "env": {
          "ELASTICSEARCH_URL": {
            "type": "userInput",
            "default": "http://elasticsearch:9200",
            "required": true
          },
          "SOAJS_ANALYTICS_ES_USERNAME": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_USERNAME"
          },
          "SOAJS_ANALYTICS_ES_PASSWORD": {
            "type": "computed",
            "value": "$SOAJS_ANALYTICS_ES_PASSWORD"
          }
        },
        "cmd": {
          "deploy": {
            "command": [
              "bash",
              "-c"
            ],
            "args": [
              "node index.js -T kibana"
            ]
          }
        }
      }
    }
  }
];

module.exports = catalogs;
