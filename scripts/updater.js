let update_timeout_id = null;
checkUpdates();

chrome.runtime.onMessage.addListener(function(request) {
  switch (request.type) {
    case "managePlugin":
      managePlugin(request.id, request.category, request.action);
      break;
    case "forceUpdate":
      checkUpdates(true);
      break;
  }
});

let ajaxGet = function (url, parseJSON, callback) {
  callback = (typeof callback == 'function' ? callback : false);
  let xhr = null;
  xhr = new XMLHttpRequest();
  if (!xhr) return null;
  xhr.open("GET", url,true);
  xhr.onreadystatechange=function() {
    if (xhr.readyState === 4 && callback) {
      showProgress(false);
      if (xhr.status === 200) {
        let response = xhr.responseText;
        if (parseJSON) {
          response = JSON.parse(response);
        }
        callback(response)
      } else {
        callback(null)
      }
    }
  };
  xhr.send(null);
  showProgress(true);
  return xhr;
};

// If popup is closed, message goes nowhere and an error occurs. Ignore.
function showProgress(value) {
  chrome.runtime.sendMessage({'type': "showProgressbar", 'value': value}, function () {
    if(chrome.runtime.lastError) { }
  });
}

function checkUpdates(force) {
  chrome.storage.local.get([
    "last_check_update",
    "update_check_interval",
    "release_iitc_version",
    "test_iitc_version",
    "release_plugins",
    "test_plugins",
    "release_plugins_local",
    "test_plugins_local"
  ], function(local){

    if (local.update_channel) {
      updateChannel = local.update_channel;
    }
    console.log('update channel (updater): '+updateChannel);

    let update_check_interval = local.update_check_interval;
    if (!update_check_interval) {
      update_check_interval = 24;
    }

    if (local[updateChannel+'_iitc_version'] === undefined || local.last_check_update === undefined) {
      downloadMeta(local);
    } else {
      let time_delta = Math.floor(Date.now() / 1000)-update_check_interval*60*60-local.last_check_update;
      if (time_delta > 0 || force) {
        ajaxGet("https://iitc.modos189.ru/updates.json", true, function (response) {
          if (response && response[updateChannel] !== local[updateChannel+'_iitc_version'] || force) {
            downloadMeta(local);
          }
        });
      }
    }

    chrome.storage.local.set({
      'last_check_update': Math.floor(Date.now() / 1000)
    });

    clearTimeout(update_timeout_id);
    update_timeout_id = setTimeout(function(){
      checkUpdates();
    }, update_check_interval*60*60*1000);
  });
}

function preparationCategories(unordered_categories) {

  let categories = {};
  Object.keys(unordered_categories).sort().forEach(function(cat) {
    if (!["Obsolete", "Deleted"].includes(cat)) {

      let plugins = {};
      let count_plugins = 0;
      unordered_categories[cat]['plugins'].forEach(function(plugin) {
        if (plugins[plugin['id']] === undefined) {
          plugin['status'] = 'off';
          plugins[plugin['id']] = plugin;
          count_plugins += 1;
        }
      });
      if (count_plugins > 0) {
        categories[cat] = unordered_categories[cat];
        categories[cat]['plugins'] = plugins;
        categories[cat]['count_plugins'] = count_plugins;
        categories[cat]['count_plugins_active'] = 0;
      }
    }
  });
  return categories;
}

function downloadMeta(local) {
  ajaxGet("https://iitc.modos189.ru/"+updateChannel+".json", true, function (response) {

    let categories = preparationCategories(response[updateChannel+'_plugins']);
    if (updateChannel === 'release') {
      chrome.storage.local.set({
        'release_iitc_version': response.release_iitc_version,
        'release_plugins': categories
      });
    } else {
      chrome.storage.local.set({
        'test_iitc_version': response.test_iitc_version,
        'test_plugins': categories
      });
    }

    console.log('download total-conversion-build.user.js');
    ajaxGet("https://iitc.modos189.ru/build/"+updateChannel+"/total-conversion-build.user.js", false, function (response) {
      if (response) {
        if (updateChannel === 'release') {
          chrome.storage.local.set({
            'release_iitc_code': response
          });
        } else {
          chrome.storage.local.set({
            'test_iitc_code': response
          });
        }
      }
    });
    updatePluginsLocal(categories, local, response);
  });
}

function updatePluginsLocal(categories, local, response) {
  let plugins_local = local[updateChannel+'_plugins_local'];

  // No plugins installed
  if (plugins_local === undefined) return;

  // Iteration local plugins
  Object.keys(plugins_local).forEach(function(id) {
    let filename = null;

    // Iteration meta categories
    Object.keys(categories).forEach(function(cat) {
      if (filename === undefined && categories[cat]['plugins'][id] !== undefined) {
        filename = categories[cat]['plugins'][id]['filename'];
        categories[cat]['count_plugins_active'] += 1;

        if (filename) {
          categories[cat]['plugins'][id]['status'] = 'on';
          ajaxGet("https://iitc.modos189.ru/build/"+updateChannel+"/plugins/"+filename, false, function (response) {});
        } else {
          delete plugins_local[id];
        }
      }
    });
  });

  if (updateChannel === 'release') {
    chrome.storage.local.set({
      'release_plugins': categories
    });
  } else {
    chrome.storage.local.set({
      'test_plugins': categories
    });
  }
}

function managePlugin(id, category, action) {
  chrome.storage.local.get([updateChannel+"_plugins", updateChannel+"_plugins_local"], function(local) {
    let plugins = local[updateChannel+'_plugins'];
    let plugins_local = local[updateChannel+'_plugins_local'];
    if (action === 'on') {

      if (plugins_local !== undefined && plugins_local[id] !== undefined) {
        // Protection against erroneous double activation
        if (plugins[category]['plugins'][id]['status'] !== 'on') {
          plugins[category]['count_plugins_active'] += 1;
        }
        plugins[category]['plugins'][id]['status'] = 'on';
        plugins_local[id]['status'] = 'on';

        if (updateChannel === 'release') {
          chrome.storage.local.set({
            'release_plugins': plugins,
            'release_plugins_local': plugins_local,
          });
        } else {
          chrome.storage.local.set({
            'test_plugins': plugins,
            'test_plugins_local': plugins_local,
          });
        }
      } else {
        if (plugins_local === undefined) {
          plugins_local = {};
        }
        let filename = plugins[category]['plugins'][id]['filename'];
        ajaxGet("https://iitc.modos189.ru/build/"+updateChannel+"/plugins/"+filename, false, function (response) {
          if (response) {
            plugins[category]['plugins'][id]['status'] = 'on';
            plugins[category]['count_plugins_active'] += 1;
            plugins_local[id] = {
              'filename': filename,
              'status': 'on',
              'code': response
            };
            if (updateChannel === 'release') {
              chrome.storage.local.set({
                'release_plugins': plugins,
                'release_plugins_local': plugins_local,
              });
            } else {
              chrome.storage.local.set({
                'test_plugins': plugins,
                'test_plugins_local': plugins_local,
              });
            }
          }
        });
      }

    }
    if (action === 'off') {

      // Protection against erroneous double activation
      if (plugins[category]['plugins'][id]['status'] !== 'off') {
        plugins[category]['count_plugins_active'] -= 1;
      }
      plugins[category]['plugins'][id]['status'] = 'off';
      plugins_local[id]['status'] = 'off';

      if (updateChannel === 'release') {
        chrome.storage.local.set({
          'release_plugins': plugins,
          'release_plugins_local': plugins_local,
        });
      } else {
        chrome.storage.local.set({
          'test_plugins': plugins,
          'test_plugins_local': plugins_local,
        });
      }

    }
  });
}