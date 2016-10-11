var fs = require('fs')
var path = require('path')
var util = require('util')
var mqtt = require('mqtt');
var express = require('express')
var morgan = require('morgan')
var bodyParser = require('body-parser')
var parameterize = require('parameterize')

var config_dir = process.env.CONFIG_DIR || './config'
var config = require(config_dir + '/config.json');

var harmonyHubDiscover = require('harmonyhubjs-discover')
var harmony = require('harmonyhubjs-client')

var harmonyHubClients = {}
var harmonyActivitiesCache = {}
var harmonyActivityUpdateInterval = 1*60*1000 // 1 minute
var harmonyActivityUpdateTimers = {}

var harmonyHubStates = {}
var harmonyStateUpdateInterval = 5*1000 // 5 seconds
var harmonyStateUpdateTimers = {}

var mqttClient = config.hasOwnProperty("mqtt_options") ?
    mqtt.connect(config.mqtt_host, config.mqtt_options) :
    mqtt.connect(config.mqtt_host);
var TOPIC_NAMESPACE = config.topic_namespace || "harmony-api";

var app = express()
app.use(bodyParser.urlencoded({ extended: false }))
app.use(express.static(path.join(__dirname, 'public')));

var logFormat = "'[:date[iso]] - :remote-addr - :method :url :status :response-time ms - :res[content-length]b'"
app.use(morgan(logFormat))

// Middleware
// Check to make sure we have a harmonyHubClient to connect to
var hasHarmonyHubClient = function(req, res, next) {
  if (Object.keys(harmonyHubClients).length > 0) {
    next()
  }else{
    res.status(500).json({message: "No hubs available."})
  }
}
app.use(hasHarmonyHubClient)


var discover = new harmonyHubDiscover(61991)

discover.on('online', function(hubInfo) {
  // Triggered when a new hub was found
  console.log('Hub discovered: ' + hubInfo.friendlyName + ' at ' + hubInfo.ip + '.')

  if (hubInfo.ip) {
    harmony(hubInfo.ip).then(function(client){
      startProcessing(parameterize(hubInfo.friendlyName), client)
    })
  }

})

discover.on('offline', function(hubInfo) {
  // Triggered when a hub disappeared
  console.log('Hub lost: ' + hubInfo.friendlyName + ' at ' + hubInfo.ip + '.')
  hubSlug = parameterize(hubInfo.friendlyName)

  clearInterval(harmonyStateUpdateTimers[hubSlug])
  clearInterval(harmonyActivityUpdateTimers[hubSlug])
  delete(harmonyHubClients[hubSlug])
  delete(harmonyActivitiesCache[hubSlug])
  delete(harmonyHubStates[hubSlug])
})

if (config.hasOwnProperty("hubs") && Array.isArray(config.hubs)) {
  config.hubs.forEach(function(hub) {
    harmony(hub.ip).then(function(client){
      startProcessing(parameterize(hub.name), client)
    })
  })
} else {
  // Look for hubs:
  console.log('Starting discovery.')
  discover.start()
}

// mqtt api

mqttClient.on('connect', function () {
  mqttClient.subscribe(TOPIC_NAMESPACE + '/hubs/+/activities/+/command')
});

mqttClient.on('message', function (topic, message) {
  var commandPattern = new RegExp(/hubs\/(.*)\/activities\/(.*)\/command/);
  var commandMatches = topic.match(commandPattern);

  if (commandMatches) {
    var hubSlug = commandMatches[1]
    var activitySlug = commandMatches[2]
    var state = message.toString()

    activity = activityBySlugs(hubSlug, activitySlug)
    if (!activity) { return }

    if (state === 'on') {
      startActivity(hubSlug, activity.id)
    }else if (state === 'off'){
      off(hubSlug)
    }
  }

});

function startProcessing(hubSlug, harmonyClient){
  harmonyHubClients[hubSlug] = harmonyClient

  // update the list of activities
  updateActivities(hubSlug)
  // then do it on the set interval
  clearInterval(harmonyActivityUpdateTimers[hubSlug])
  harmonyActivityUpdateTimers[hubSlug] = setInterval(function(){ updateActivities(hubSlug) }, harmonyActivityUpdateInterval)

  // update the state
  updateState(hubSlug)
  // update the list of activities on the set interval
  clearInterval(harmonyStateUpdateTimers[hubSlug])
  harmonyStateUpdateTimers[hubSlug] = setInterval(function(){ updateState(hubSlug) }, harmonyStateUpdateInterval)
}

function updateActivities(hubSlug){
  harmonyHubClient = harmonyHubClients[hubSlug]

  if (!harmonyHubClient) { return }
  console.log('Updating activities for ' + hubSlug + '.')

  try {
    harmonyHubClient.getActivities().then(function(activities){
      foundActivities = {}
      activities.some(function(activity) {
        foundActivities[activity.id] = {id: activity.id, slug: parameterize(activity.label), label:activity.label, isAVActivity: activity.isAVActivity}
      })

      harmonyActivitiesCache[hubSlug] = foundActivities
    })
  } catch(err) {
    console.log("ERROR: " + err.message);
  }

}

function updateState(hubSlug){
  harmonyHubClient = harmonyHubClients[hubSlug]

  if (!harmonyHubClient) { return }
  console.log('Updating state for ' + hubSlug + '.')

  // save for comparing later after we get the true current state
  var previousActivity = currentActivity(hubSlug)

  try {
    harmonyHubClient.getCurrentActivity().then(function(activityId){
      data = {off: true}

      activity = harmonyActivitiesCache[hubSlug][activityId]

      if (activityId != -1 && activity) {
        data = {off: false, current_activity: activity}
      }else{
        data = {off: true, current_activity: activity}
      }

      // cache state for later
      harmonyHubStates[hubSlug] = data

      if (!previousActivity || (activity.id != previousActivity.id)) {
        publish('hubs/' + hubSlug + '/' + 'current_activity', activity.slug, {retain: true})
        publish('hubs/' + hubSlug + '/' + 'state', activity.id == -1 ? 'off' : 'on' , {retain: true})

        for (var i = 0; i < cachedHarmonyActivities(hubSlug).length; i++) {
          activities = cachedHarmonyActivities(hubSlug)
          cachedActivity = activities[i]

          if (activity == cachedActivity) {
            publish('hubs/' + hubSlug + '/' + 'activities/' + cachedActivity.slug + '/state', 'on', {retain: true})
          }else{
            publish('hubs/' + hubSlug + '/' + 'activities/' + cachedActivity.slug + '/state', 'off', {retain: true})
          }
        }
      }

    })
  } catch(err) {
    console.log("ERROR: " + err.message);
  }

}

function cachedHarmonyActivities(hubSlug){
  activities = harmonyActivitiesCache[hubSlug]
  if (!activities) { return [] }

  return Object.keys(harmonyActivitiesCache[hubSlug]).map(function(key) {
    return harmonyActivitiesCache[hubSlug][key]
  })
}

function currentActivity(hubSlug){
  harmonyHubClient = harmonyHubClients[hubSlug]
  harmonyHubState = harmonyHubStates[hubSlug]
  if (!harmonyHubClient || !harmonyHubState) { return null}

  return harmonyHubState.current_activity
}

function activityBySlugs(hubSlug, activitySlug){
  var activity
  cachedHarmonyActivities(hubSlug).some(function(a) {
    if(a.slug === activitySlug) {
      activity = a
      return true
    }
  })

  return activity
}

function off(hubSlug){
  harmonyHubClient = harmonyHubClients[hubSlug]
  if (!harmonyHubClient) { return }

  harmonyHubClient.turnOff().then(function(){
    updateState(hubSlug)
  })
}

function startActivity(hubSlug, activityId){
  harmonyHubClient = harmonyHubClients[hubSlug]
  if (!harmonyHubClient) { return }

  harmonyHubClient.startActivity(activityId).then(function(){
    updateState(hubSlug)
  })
}

function publish(topic, message, options){
  topic = TOPIC_NAMESPACE + "/" + topic
  mqttClient.publish(topic, message, options);
}

app.get('/_ping', function(req, res){
  res.send('OK');
})

app.get('/', function(req, res){
  res.sendfile('index.html');
})

app.get('/hubs', function(req, res){
  res.json({hubs: Object.keys(harmonyHubClients)})
})

app.get('/hubs/:hubSlug/activities', function(req, res){
  hubSlug = req.params.hubSlug
  harmonyHubClient = harmonyHubClients[hubSlug]

  if (harmonyHubClient) {
    res.json({activities: cachedHarmonyActivities(hubSlug)})
  }else{
    res.status(404).json({message: "Not Found"})
  }
})

app.get('/hubs/:hubSlug/status', function(req, res){
  hubSlug = req.params.hubSlug
  harmonyHubClient = harmonyHubClients[hubSlug]

  if (harmonyHubClient) {
    res.json(harmonyHubStates[hubSlug])
  }else{
    res.status(404).json({message: "Not Found"})
  }
})

app.put('/hubs/:hubSlug/off', function(req, res){
  hubSlug = req.params.hubSlug
  harmonyHubClient = harmonyHubClients[hubSlug]

  if (harmonyHubClient) {
    off(hubSlug)
    res.json({message: "ok"})
  }else{
    res.status(404).json({message: "Not Found"})
  }
})

app.post('/hubs/:hubSlug/start_activity', function(req, res){
  activity = activityBySlugs(req.params.hubSlug, req.query.activity)

  if (activity) {
    startActivity(req.params.hubSlug, activity.id)

    res.json({message: "ok"})
  }else{
    res.status(404).json({message: "Not Found"})
  }
})

app.get('/hubs_for_index', function(req, res){
  hubSlugs = Object.keys(harmonyHubClients)
  output = ""

  Object.keys(harmonyHubClients).forEach(function(hubSlug) {
    output += '<h3 class="hub-name">' + hubSlug.replace('-', ' ') + '</h3>'
    output += '<p><span class="method">GET</span> <a href="/hubs/' + hubSlug + '/status">/hubs/' + hubSlug + '/status</a></p>'
    output += '<p><span class="method">GET</span> <a href="/hubs/' + hubSlug + '/activities">/hubs/' + hubSlug + '/activities</a></p>'
  });

  res.send(output)
})

app.listen(process.env.PORT || 8282)
