var oldPublish = Meteor.publish;

Meteor.publish = function (name, handler, options) {
  options = options || {};

  var httpOptionKeys = [
    "url"
  ];

  var httpOptions = _.pick(options, httpOptionKeys);
  var ddpOptions = _.omit(options, httpOptionKeys);

  // Register DDP publication
  oldPublish(name, handler, ddpOptions);

  var url = httpOptions["url"] || "publications/" + name;

  JsonRoutes.add("get", url, function (req, res) {
    catchAndReportErrors(url, res, function () {
      var userId = getUserIdFromRequest(req);

      var httpSubscription = new HttpSubscription({
        request: req,
        userId: userId
      });

      httpSubscription.on("ready", function (response) {
        JsonRoutes.sendResult(res, 200, response);
      });

      var handlerArgs = getArgsFromRequest(req);

      var handlerReturn = handler.apply(httpSubscription, handlerArgs);

      // Fast track for publishing cursors - we don't even need livequery here,
      // just making a normal DB query
      if (handlerReturn && handlerReturn._publishCursor) {
        httpPublishCursor(handlerReturn, httpSubscription);
        httpSubscription.ready();
      } else if (handlerReturn && _.isArray(handlerReturn)) {
        // We don't need to run the checks to see if the cursors overlap and stuff
        // because calling Meteor.publish will do that for us :]
        _.each(handlerReturn, function (cursor) {
          httpPublishCursor(cursor, httpSubscription);
        });

        httpSubscription.ready();
      }
    });
  });
};

var oldMethods = Object.getPrototypeOf(Meteor.server).methods;
Meteor.method = function (name, handler, options) {
  options = options || {};
  var methodMap = {};
  methodMap[name] = handler;
  oldMethods.call(Meteor.server, methodMap);

  // This is a default collection mutation method, do some special things to
  // make it more RESTful
  if (insideDefineMutationMethods) {
    var collectionName = name.split("/")[1];
    var modifier = name.split("/")[2];

    var collectionUrl = "/" + collectionName;
    var itemUrl = "/" + collectionName + "/:_id";

    if (modifier === "insert") {
      // Post the entire new document
      addHTTPMethod("post", collectionUrl, handler);
    } else if (modifier === "update") {
      // PATCH means you submit an incomplete document, to update the fields
      // you have passed
      addHTTPMethod("patch", itemUrl, handler, {
        getArgsFromRequest: function (req) {
          return [{ _id: req.params._id }, { $set: req.body }];
        }
      });

      // We don't have PUT because allow/deny doesn't let you replace documents
      // you can define it manually if you want
    } else if (modifier === "remove") {
      // Can only remove a single document by the _id
      addHTTPMethod("delete", itemUrl, handler, {
        getArgsFromRequest: function (req) {
          return [req.params._id];
        }
      });
    }

    return;
  }

  if (name[0] !== "/") {
    name = "/" + name;
  }
  var autoName = "methods" + name;
  var url = options.url || autoName;

  addHTTPMethod("post", url, handler);
};

// Monkey patch _defineMutationMethods so that we can treat them specially
// inside Meteor.method
var insideDefineMutationMethods = false;
var oldDMM = Mongo.Collection.prototype._defineMutationMethods;
Mongo.Collection.prototype._defineMutationMethods = function () {
  insideDefineMutationMethods = true;
  oldDMM.apply(this, arguments);
  insideDefineMutationMethods = false;
};

Meteor.methods = Object.getPrototypeOf(Meteor.server).methods =
  function (methodMap) {
    _.each(methodMap, function (handler, name) {
      Meteor.method(name, handler);
    });
  };

function addHTTPMethod(httpMethod, url, handler, options) {
  var options = _.defaults(options || {}, {
    getArgsFromRequest: getArgsFromRequest
  });

  JsonRoutes.add("options", url, function (req, res) {
    JsonRoutes.sendResult(res, 200);
  });

  JsonRoutes.add(httpMethod, url, function (req, res) {
    catchAndReportErrors(url, res, function () {
      var userId = getUserIdFromRequest(req);

      // XXX replace with a real one?
      var methodInvocation = {
        userId: userId,
        setUserId: function () {
          throw Error("setUserId not implemented in this version of simple:rest");
        },
        isSimulation: false,
        unblock: function () {
          // no-op
        }
      };

      var handlerArgs = options.getArgsFromRequest(req);
      var handlerReturn = handler.apply(methodInvocation, handlerArgs);
      JsonRoutes.sendResult(res, 200, handlerReturn);
    });
  });
}

function httpPublishCursor(cursor, subscription) {
  _.each(cursor.fetch(), function (document) {
    subscription.added(cursor._cursorDescription.collectionName,
      document._id, document);
  });
}

function getArgsFromRequest(methodScope) {
  var args = [];
  if (methodScope.method === "POST") {
    // by default, the request body is an array which is the arguments
    args = EJSON.fromJSONValue(methodScope.body);
  }

  _.each(methodScope.params, function (value, name) {
    var parsed = parseInt(name, 10);

    if (_.isNaN(parsed)) {
      throw new Error("REST publish doesn't support parameters whose names aren't integers.");
    }

    args[parsed] = value;
  });

  return args;
}

function hashToken(unhashedToken) {
  check(unhashedToken, String);

  // The Accounts._hashStampedToken function has a questionable API where
  // it actually takes an object of which it only uses one property, so don't
  // give it any more properties than it needs.
  var hashStampedTokenArg = { token: unhashedToken };
  var hashStampedTokenReturn = Package["accounts-base"].Accounts._hashStampedToken(hashStampedTokenArg);
  check(hashStampedTokenReturn, {
    hashedToken: String
  });

  // Accounts._hashStampedToken also returns an object, get rid of it and just
  // get the one property we want.
  return hashStampedTokenReturn.hashedToken;
}

function getUserIdFromRequest(req) {
  if (! _.has(Package, "accounts-base")) {
    return null;
  }

  // Looks like "Authorization: Bearer <token>"
  var token = req.headers.authorization &&
    req.headers.authorization.split(" ")[1];

  if (! token) {
    return null;
  }

  // Check token expiration
  var tokenExpires = Package["accounts-base"].Accounts._tokenExpiration(token.when);
  if (new Date() >= tokenExpires) {
    throw new Meteor.Error("token-expired", "Your login token has expired. Please log in again.");
  }

  var user = Meteor.users.findOne({
    "services.resume.loginTokens.hashedToken": hashToken(token)
  });

  if (user) {
    return user._id;
  } else {
    return null;
  }
}

function catchAndReportErrors(url, res, func) {
  try {
    return func();
  } catch (error) {
    var errorJson;
    if (error instanceof Meteor.Error) {
      errorJson = {
        error: error.error,
        reason: error.reason,
        details: error.details
      };
    } else {
      console.log("Internal server error in " + url, error, error.stack);
      errorJson = {
        error: "internal-server-error",
        reason: "Internal server error"
      };
    }
    JsonRoutes.sendResult(res, 500, errorJson);
  }
}
