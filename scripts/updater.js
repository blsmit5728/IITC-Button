Object.prototype.sortByKey = function(key){
  let arr = [];
  for (let prop in this) {
    if (this.hasOwnProperty(prop)) {
      let obj = {};
      obj[prop] = this[prop];
      obj.tempSortName = this[prop][key].toLowerCase();
      arr.push(obj);
    }
  }

  arr.sort(function(a, b) {
    let at = a.tempSortName,
      bt = b.tempSortName;
    return at > bt ? 1 : ( at < bt ? -1 : 0 );
  });

  let result = {};
  for (let i=0, l=arr.length; i<l; i++) {
    let obj = arr[i];
    let id;
    delete obj.tempSortName;
    for (let prop in obj) {
      if (obj.hasOwnProperty(prop)) {
        id = prop;
      }
    }
    result[id] = obj[id];
  }
  return result;
};

let progressIntervalId = null;
let update_timeout_id = null;
let external_update_timeout_id = null;
checkUpdates();
checkExternalUpdates();

chrome.runtime.onMessage.addListener(function(request) {
  switch (request.type) {
    case "managePlugin":
      managePlugin(request.id, request.category, request.action);
      break;
    case "safeUpdate":
      checkUpdates(false);
      break;
    case "forceFullUpdate":
      checkUpdates(true);
      checkExternalUpdates(true);
      break;
    case "addUserScripts":
      addUserScripts(request.scripts);
      break;
  }
});

const save = (options) => new Promise(resolve => {
  let data = {};
  Object.keys(options).forEach(function (key) {
    if (['iitc_version', 'last_modified', 'iitc_code', 'plugins', 'plugins_local', 'plugins_user'].indexOf(key) !== -1) {
      console.log('save '+channel+'_'+key);
      data[channel+'_'+key] = options[key];
    } else {
      data[key] = options[key];
    }
  });
  chrome.storage.local.set(data, resolve());
});


const ajaxGetWithProgress = (url, variant) => new Promise(async resolve => {
  clearInterval(progressIntervalId);
  progressIntervalId = setInterval(function() { showProgress(true) }, 300);
  let response = await ajaxGet(url, variant);
  if (response) {
    clearInterval(progressIntervalId);
    showProgress(false);
  }
  resolve(response);
});


// If popup is closed, message goes nowhere and an error occurs. Ignore.
function showProgress(value) {
  chrome.runtime.sendMessage({'type': "showProgressbar", 'value': value}, function () {
    if(chrome.runtime.lastError) { }
  });
}

function checkUpdates(force, retry) {
  chrome.storage.local.get([
    "channel",
    "last_check_update",
    "local_server_host",
    "release_update_check_interval", "test_update_check_interval", "local_update_check_interval",
    "release_last_modified",         "test_last_modified",         "local_last_modified",
    "release_plugins",               "test_plugins",               "local_plugins",
    "release_plugins_local",         "test_plugins_local",         "local_plugins_local",
    "release_plugins_user",          "test_plugins_user",          "local_plugins_user"
  ], async function(local) {

    if (local.channel) channel = local.channel;
    if (local.local_server_host) network_host['local'] = "http://" + local.local_server_host;

    let update_check_interval = local[channel+'_update_check_interval']*60*60;
    if (!update_check_interval) update_check_interval = 24*60*60;
    if (channel === 'local') update_check_interval = 5; // check every 5 seconds

    if (retry === undefined) {
      clearTimeout(update_timeout_id); update_timeout_id = null;
      retry = 0;
    }

    if (local[channel+'_last_modified'] === undefined || local.last_check_update === undefined) {
      clearTimeout(update_timeout_id); update_timeout_id = null;
      await downloadMeta(local, null);
    } else {
      let time_delta = Math.floor(Date.now() / 1000)-update_check_interval-local.last_check_update;
      if (time_delta >= 0 || force) {
        clearTimeout(update_timeout_id); update_timeout_id = null;
        let last_modified = await ajaxGetWithProgress(network_host[channel]+"/meta.json", "Last-Modified");
        if (last_modified) {
          if (last_modified !== local[channel+'_last_modified'] || force) {
            await downloadMeta(local, last_modified);
          }
        } else {
          retry += 1;
          let seconds = retry*retry;
          if (seconds > 60*60*24) seconds = 60*60*24;
          chrome.runtime.sendMessage({'type': "showMessage", 'message': _('serverNotAvailableRetry', seconds.toString())});
          update_timeout_id = setTimeout(function(){
            checkUpdates(true, retry);
          }, seconds*1000);
        }
      }
    }

    if (!update_timeout_id) {
      await save({
        'last_check_update': Math.floor(Date.now() / 1000)
      });

      update_timeout_id = setTimeout(function () {
        checkUpdates();
      }, update_check_interval * 1000);
    }
  });
}

async function downloadMeta(local, last_modified) {
  let response = await ajaxGetWithProgress(network_host[channel]+"/meta.json", "parseJSON");
  if (!response) return;

  let plugins = response['categories'];
  let plugins_local = local[channel+'_plugins_local'];
  let plugins_user = local[channel+'_plugins_user'];

  let iitc_code = await ajaxGetWithProgress(network_host[channel]+"/total-conversion-build.user.js");
  if (iitc_code) {
    await save({
      'iitc_code': iitc_code
    })
  }

  plugins_local = await updateLocalPlugins(plugins, plugins_local);

  plugins = rebuildingCategoriesPlugins(plugins, plugins_local, plugins_user);
  await save({
    'iitc_version': response['iitc_version'],
    'last_modified': last_modified,
    'plugins': plugins,
    'plugins_local': plugins_local,
    'plugins_user': plugins_user
  });
}

function checkExternalUpdates(force) {
  chrome.storage.local.get([
    "channel",
    "last_check_external_update",
    "external_update_check_interval",
    "release_plugins_user",          "test_plugins_user",          "local_plugins_user"
  ], async function(local){

    if (local.channel) channel = local.channel;

    let update_check_interval = local['external_update_check_interval']*60*60;
    if (!update_check_interval) {
      update_check_interval = 24*60*60;
    }

    let time_delta = Math.floor(Date.now() / 1000)-update_check_interval-local.last_check_external_update;
    if (time_delta >= 0 || force) {
      clearTimeout(external_update_timeout_id); external_update_timeout_id = null;
      await updateExternalPlugins(local);
    }

    if (!external_update_timeout_id) {
      await save({
        'last_check_external_update': Math.floor(Date.now() / 1000)
      });

      clearTimeout(external_update_timeout_id); external_update_timeout_id = null;
      external_update_timeout_id = setTimeout(function () {
        checkUpdates();
      }, update_check_interval * 1000);
    }
  });
}

async function updateExternalPlugins(local) {
  let plugins_user = local[channel+'_plugins_user'];
  if (plugins_user) {
    let exist_updates = false;
    let hash = "?"+Date.now();

    let promises = Object.keys(plugins_user).map(async function(id) {
      let plugin = plugins_user[id];

      if (plugin['updateURL'] && plugin['downloadURL']) {

        // download meta info
        let response_meta = await ajaxGetWithProgress(plugin['updateURL']+hash);
        if (response_meta) {
          let meta = parse_meta(response_meta);
          // if new version
          if (meta && meta['version'] && meta['version'] !== plugin['version']) {
            // download userscript
            let response_code = await ajaxGetWithProgress(plugin['updateURL']+hash);
            if (response_code) {
              exist_updates = true;
              plugins_user[id] = meta;
              plugins_user[id]['code'] = response_code;
            }
          }
        }
      }
    });

    await Promise.all(promises);
    if (exist_updates) {
      await save({
        'plugins_user': plugins_user
      })
    }
  }
}

async function updateLocalPlugins(plugins, plugins_local) {
  // If no plugins installed
  if (plugins_local === undefined) return {};

  // Iteration local plugins
  let promises = Object.keys(plugins_local).map(async function(id) {
    let filename = plugins_local[id]['filename'];

    let keep = false;
    // View all categories, because the plugin could change the category
    Object.keys(plugins).forEach(function (cat) {
      plugins[cat]['plugins'].forEach(function (plugin) {
        if (plugin['id'] === id) {
          keep = true;
        }
      });
    });

    if (filename && keep) {
      let code = await ajaxGetWithProgress(network_host[channel]+"/plugins/" + filename);
      if (code) plugins_local[id]['code'] = code;
    } else {
      delete plugins_local[id];
    }
  });
  await Promise.all(promises);
  return plugins_local;
}

function managePlugin(id, category, action) {
  chrome.storage.local.get([channel+"_plugins", channel+"_plugins_local", channel+"_plugins_user"], async function(local) {
    let plugins = local[channel+'_plugins'];
    let plugins_local = local[channel+'_plugins_local'];
    let plugins_user = local[channel+'_plugins_user'];
    if (action === 'on') {

      if (category !== "External" && plugins_local !== undefined && plugins_local[id] !== undefined ||
          category === "External" && plugins_user !== undefined && plugins_user[id] !== undefined) {

        // Protection against erroneous double activation
        if (plugins[category]['plugins'][id]['status'] !== 'on') {
          plugins[category]['count_plugins_active'] += 1;
        }
        plugins[category]['plugins'][id]['status'] = 'on';
        if (category === "External") {
          plugins_user[id]['status'] = 'on';
        } else {
          plugins_local[id]['status'] = 'on';
        }

        injectUserScript(preparationUserScript(plugins[category]['plugins'][id], id));

        await save({
          'plugins': plugins,
          'plugins_local': plugins_local,
          'plugins_user': plugins_user
        })

      } else {
        if (plugins_local === undefined) {
          plugins_local = {};
        }
        let filename = plugins[category]['plugins'][id]['filename'];
        let response = await ajaxGetWithProgress(network_host[channel]+"/plugins/"+filename);
        if (response) {
          plugins[category]['plugins'][id]['status'] = 'on';
          plugins[category]['count_plugins_active'] += 1;
          plugins_local[id] = plugins[category]['plugins'][id];
          plugins_local[id]['category'] = category;
          plugins_local[id]['status'] = 'on';
          plugins_local[id]['code'] = response;

          injectUserScript(preparationUserScript(plugins_local[id], id));

          await save({
            'plugins': plugins,
            'plugins_local': plugins_local
          })
        }
      }

    }
    if (action === 'off') {

      // Protection against erroneous double activation
      if (plugins[category]['plugins'][id]['status'] !== 'off') {
        plugins[category]['count_plugins_active'] -= 1;
      }
      plugins[category]['plugins'][id]['status'] = 'off';
      if (category === 'External') {
        plugins_user[id]['status'] = 'off';
      } else {
        plugins_local[id]['status'] = 'off';
      }

      await save({
        'plugins': plugins,
        'plugins_local': plugins_local,
        'plugins_user': plugins_user
      })

    }
    if (action === 'delete') {

      plugins['External']['count_plugins'] -= 1;
      if (plugins['External']['plugins'][id]['status'] === 'on') {
        plugins['External']['count_plugins_active'] -= 1;
      }
      if (plugins['External']['count_plugins'] === 0) {
        delete plugins['External'];
      } else {
        delete plugins['External']['plugins'][id];
      }
      delete plugins_user[id];

      Object.keys(plugins).forEach(function(cat) {
        if (plugins[cat]['plugins'][id] !== undefined && plugins[cat]['plugins'][id]['status'] === 'user') {
          plugins[cat]['plugins'][id]['status'] = 'off';
        }
      });

      await save({
        'plugins': plugins,
        'plugins_local': plugins_local,
        'plugins_user': plugins_user
      })
    }
  });
}

function addUserScripts(scripts) {
  chrome.storage.local.get([channel+"_plugins", channel+"_plugins_local", channel+"_plugins_user"], async function(local) {
    let plugins = local[channel + '_plugins'];
    let plugins_local = local[channel + '_plugins_local'];
    let plugins_user = local[channel + '_plugins_user'];

    if (plugins_local === undefined) plugins_local = {};
    if (plugins_user === undefined) plugins_user = {};

    scripts.forEach(function(script) {
      let meta = script['meta'];
      let code = script['code'];
      let id = meta['id'];

      plugins_user[id] = meta;
      plugins_user[id]['status'] = 'on';
      plugins_user[id]['code'] = code;
    });

    plugins = rebuildingCategoriesPlugins(plugins, plugins_local, plugins_user);

    await save({
      'plugins': plugins,
      'plugins_local': plugins_local,
      'plugins_user': plugins_user
    })
  });
}

function rebuildingCategoriesPlugins(raw_plugins, plugins_local, plugins_user) {
  let data = {};
  if (plugins_local === undefined) plugins_local = {};
  if (plugins_user === undefined) plugins_user = {};

  let plugins_user_length = Object.keys(plugins_user).length;

  if (plugins_user_length) {
    data['External'] = {
      'name': 'External',
      'description': '',
      'plugins': {},
      'count_plugins': 0,
      'count_plugins_active': 0,
    };
  }

  if (raw_plugins["Obsolete"] !== undefined) delete raw_plugins["Obsolete"];
  if (raw_plugins["Deleted"] !== undefined) delete raw_plugins["Deleted"];
  data = {...data, ...raw_plugins};

  // Prepare plugins
  Object.keys(data).forEach(function (cat) {
    let plugins = {};
    let count_all = 0;
    if ('plugins' in data[cat]) {
      Object.keys(data[cat]['plugins']).forEach(function (id) {
        let plugin = data[cat]['plugins'][id];
        if (plugins[plugin['id']] === undefined) {
          count_all += 1;
          plugin['status'] = 'off';
          plugins[plugin['id']] = plugin;
        }
      });
      if (count_all > 0 || cat === 'External') {
        data[cat]['plugins'] = plugins.sortByKey('name');
        data[cat]['count_plugins'] = count_all;
        data[cat]['count_plugins_active'] = 0;
      } else {
        delete data[cat];
      }
    }
  });

  // Build local plugins
  Object.keys(plugins_local).forEach(function (plugin_id) {
    let local = plugins_local[plugin_id];
    let plugin_cat = local['category'];

    data[plugin_cat]['plugins'][plugin_id]['status'] = local['status'];
    data[plugin_cat]['count_plugins_active'] += 1;
  });

  // Build External plugins
  if (plugins_user_length) {
    let count_all = 0;
    let count_active = 0;
    let userscripts = {};
    Object.keys(plugins_user).forEach(function (id) {
      Object.keys(data).forEach(function (cat) {
        // check for "plugins" key. Right now there's nothing in "Keys" and it causes a fault
        if( "plugins" in data[cat] ) {
          // Now see if what we're going to add is even in the "plugins" for that key/value pair.
          if ( id in data[cat]['plugins'] ) {
            // Make sure it's not undefined.
            if (data[cat]['plugins'][id] !== undefined) {
              if (data[cat]['plugins'][id]['status'] === 'on') {
                data[cat]['count_plugins_active'] -= 1;
              }
              data[cat]['plugins'][id]['status'] = 'user';
              if (plugins_local[id] !== undefined) {
                plugins_local[id]['status'] = 'user';
              }
            }
          }
        }
      });
      count_all += 1;
      if (plugins_user[id]['status'] === 'on') count_active += 1;
      userscripts[id] = plugins_user[id];
    });
    data['External']['plugins'] = userscripts.sortByKey('name');
    data['External']['count_plugins'] = count_all;
    data['External']['count_plugins_active'] = count_active;
  }

  return data;
}
