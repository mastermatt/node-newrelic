'use strict'

var chai = require('chai')
var should = chai.should()
var expect = chai.expect
var EventEmitter = require('events').EventEmitter
var helper = require('../../../lib/agent_helper')
var hashes = require('../../../../lib/util/hashes')
var Segment = require('../../../../lib/transaction/trace/segment')
var semver = require('semver')


var NEWRELIC_ID_HEADER = 'x-newrelic-id'
var NEWRELIC_APP_DATA_HEADER = 'x-newrelic-app-data'
var NEWRELIC_TRANSACTION_HEADER = 'x-newrelic-transaction'

describe("built-in http module instrumentation", function() {
  var http

  var PAYLOAD = JSON.stringify({msg : 'ok'})

  var PAGE = '<html>' +
    '<head><title>test response</title></head>' +
    '<body><p>I heard you like HTML.</p></body>' +
    '</html>'

  describe("shouldn't cause bootstrapping to fail", function() {
    var initialize
    var agent

    before(function() {
      agent = helper.loadMockedAgent()
      initialize = require('../../../../lib/instrumentation/core/http')
    })

    after(function() {
      helper.unloadAgent(agent)
    })

    it("when passed no module", function() {
      expect(function() { initialize(agent) }).not.throws()
    })

    it("when passed an empty module", function() {
      expect(function() { initialize(agent, {}) }).not.throws()
    })
  })

  describe("after loading", function() {
    var agent

    before(function() {
      agent = helper.instrumentMockedAgent()
    })

    after(function() {
      helper.unloadAgent(agent)
    })

    it("shouldn't have changed createServer's declared parameter names", function() {
      var http = require('http')
      var fn = http.createServer
      /* Taken from
       * https://github.com/dhughes/CoolBeans/blob/master/lib/CoolBeans.js#L199
       */
      var params = fn.toString().match(/function\s+\w*\s*\((.*?)\)/)[1].split(/\s*,\s*/)
      expect(params).eql(['requestListener'])
    })
  })

  describe("with outbound request mocked", function() {
    var agent
    var http
    var options


    beforeEach(function() {
      agent = helper.loadMockedAgent()
      var initialize = require('../../../../lib/instrumentation/core/http')
      http = {
        request : function request(_options) {
          options = _options

          var requested = new EventEmitter()
          requested.path = '/TEST'
          if (options.path) requested.path = options.path

          return requested
        }
      }

      initialize(agent, http)
    })

    afterEach(function() {
      helper.unloadAgent(agent)
    })

    it("shouldn't crash when called with undefined host", function() {
      helper.runInTransaction(agent, function() {
        expect(function() { http.request({port : 80}) }).not.throws()
      })
    })

    it("shouldn't crash when called with undefined port", function() {
      helper.runInTransaction(agent, function() {
        expect(function() { http.request({host : 'localhost'}) }).not.throws()
      })
    })
  })

  describe("when running a request", function() {
    var transaction = null
    var transaction2 = null
    var hookCalled = null
    var agent = null


    before(function(done) {
      http = require('http')
      agent = helper.instrumentMockedAgent()
      hookCalled = false

      var external = http.createServer(function cb_createServer(request, response) {
        should.exist(agent.getTransaction())

        response.writeHead(200, {
          'Content-Length': PAYLOAD.length,
          'Content-Type': 'application/json'
        })
        response.end(PAYLOAD)
      })

      var server = http.createServer(function cb_createServer(request, response) {
        transaction = agent.getTransaction()
        should.exist(transaction)

        if (/\/slow$/.test(request.url)) {
          setTimeout(function() {
            response.writeHead(200, {
              'Content-Length': PAGE.length,
              'Content-Type': 'text/html'
            })
            response.end(PAGE)
          }, 500)
          return
        }

        makeRequest({
          port: 8321,
          host: 'localhost',
          path: '/status',
          method: 'GET'
        }, function(err, statusCode, data) {
          if (err) {
            response.writeHead(500)
            response.end(err.toString())
            return
          }

          if (statusCode !== 200) {
            response.writeHead(501)
            response.end('bad status code: ' + statusCode)
          }

          if (data !== PAYLOAD) {
            response.writeHead(502)
            response.end('bad payload')
          }

          response.writeHead(200, {
            'Content-Length': PAGE.length,
            'Content-Type': 'text/html'
          })
          response.end(PAGE)
        })
      })

      server.on('request', function() {
        transaction2 = agent.getTransaction()
      })

      server.__NR_onRequestStarted = function() {
        hookCalled = true
      }

      external.listen(8321, 'localhost', function() {
        server.listen(8123, 'localhost', function() {
          // The transaction doesn't get created until after the instrumented
          // server handler fires.
          should.not.exist(agent.getTransaction())
          done()
        })
      })
    })

    after(function() {
      helper.unloadAgent(agent)
    })

    function makeRequest(params, cb) {
      var req = http.request(params, function(res) {
        if (res.statusCode !== 200) {
          return cb(null, res.statusCode, null)
        }

        res.setEncoding('utf8')
        res.on('data', function(data) {
          cb(null, res.statusCode, data)
        })
      })

      req.on('error', function(err) {
        // If we aborted the request and the error is a connection reset, then
        // all is well with the world. Otherwise, ERROR!
        if (params.abort && err.code === 'ECONNRESET') {
          cb()
        } else {
          cb(err)
        }
      })

      if (params.abort) {
        setTimeout(function() {
          req.abort()
        }, params.abort)
      }
      req.end()
    }

    describe('that is successful', function() {
      var fetchedStatusCode = null
      var fetchedBody = null
      var refererUrl = 'https://www.google.com/search/cats?scrubbed=false'

      before(function(done) {
        transaction = null
        makeRequest({
          port: 8123,
          host: 'localhost',
          path: '/path',
          method: 'GET',
          headers: {
            referer: refererUrl
          }
        }, function(err, statusCode, body) {
          fetchedStatusCode = statusCode
          fetchedBody = body
          done(err)
        })
      })

      after(function() {
        fetchedStatusCode = null
        fetchedBody = null
      })

      it("should successfully fetch the page", function() {
        fetchedStatusCode.should.equal(200)

        should.exist(fetchedBody)
        expect(fetchedBody).equal(PAGE)
      })

      it("should capture a scrubbed version of the referer header", function() {
        expect(transaction.trace.parameters['request.headers.referer']).to.equal('https://www.google.com/search/cats')
      })

      it("should record unscoped path stats after a normal request", function() {
        var stats = agent.metrics.getOrCreateMetric('WebTransaction/NormalizedUri/*')
        expect(stats.callCount).equal(2)
      })

      it("should indicate that the http dispatcher is in play", function() {
        expect(agent.environment.get('Dispatcher')).to.include('http')
      })

      it("should record unscoped HTTP dispatcher stats after a normal request",
         function() {
        var stats = agent.metrics.getOrCreateMetric('HttpDispatcher')
        expect(stats.callCount).equal(2)
      })

      it("should associate outbound HTTP requests with the inbound transaction",
         function() {
        var stats = transaction
                      .metrics
                      .getOrCreateMetric('External/localhost:8321/http',
                                         'WebTransaction/NormalizedUri/*')
        expect(stats.callCount).equal(1)
      })

      it("should capture metrics for the last byte to exit as part of a response")
      it("should capture metrics for the last byte to enter as part of a request")

      it("should set transaction.port to the server's port", function() {
        expect(transaction.port).equal(8123)
      })

      it('should only create one transaction for the request', function() {
        expect(transaction2).to.have.property('id', transaction.id)
      })

      it('should call the shim hook', function() {
        expect(hookCalled).to.be.true()
      })
    })

    describe('that aborts', function() {
      before(function(done) {
        transaction = null
        makeRequest({
          port: 8123,
          host: 'localhost',
          path: '/slow',
          method: 'GET',
          abort: 15
        }, function(err) {
          done(err)
        })
      })

      it('should still finish the transaction', function() {
        expect(transaction).to.exist
        expect(transaction.isActive()).to.be.false
      })
    })
  })

  describe("with error monitor", function() {
    var mochaHandlers
    var agent

    before(function() {
      // disable mocha's error handler
      mochaHandlers = helper.onlyDomains()
    })

    after(function() {
      process._events.uncaughtException = mochaHandlers
    })

    beforeEach(function() {
      http = require('http')
      agent = helper.instrumentMockedAgent()
    })

    afterEach(function() {
      helper.unloadAgent(agent)
    })

    it("should have stored mocha's exception handler", function() {
      should.exist(mochaHandlers)
      expect(mochaHandlers.length).above(0)
    })

    describe("for http.createServer", function() {
      it("should trace errors in top-level handlers", function(done) {
        var server
        process.once('uncaughtException', function() {
          var errors = agent.errors.errors
          expect(errors.length).equal(1)

          server.close()
          return done()
        })

        server = http.createServer(function cb_createServer() {
          throw new Error("whoops!")
        })

        server.listen(8182, function() {
          http.get({host : 'localhost', port : 8182}, function() {
            done("actually got response")
          })
        })
      })
    })

    describe("for http.request", function() {
      // this scenario is specifically broken on Node 5.7.1, see
      // https://github.com/nodejs/node/issues/5555
      if (!semver.satisfies(process.versions.node, '==5.7.1')) return

      it("should trace errors in listeners", function(done) {
        var server
        process.once('uncaughtException', function() {
          var errors = agent.errors.errors
          expect(errors.length).equal(1)

          server.close()
          return done()
        })

        server = http.createServer(function cb_createServer(request, response) {
          response.writeHead(200, {'Content-Type': 'text/plain'})
          response.end()
        })

        server.listen(8183, function() {
          http.get({host : 'localhost', port : 8183}, function() {
            throw new Error("whoah")
          })
        })
      })
    })
  })

  describe('inbound http requests when cat is enabled', function() {
    var encKey = 'gringletoes'
    var agent

    before(function() {
      agent = helper.instrumentMockedAgent(null, {
        cross_application_tracer: {enabled: true},
        encoding_key: encKey
      })
    })

    after(function() {
      helper.unloadAgent(agent)
    })

    it('should add cat headers from request to transaction', function(done) {
      var server = http.createServer(function(req, res) {
        var transaction = agent.getTransaction()
        expect(transaction.incomingCatId).equal('123')
        expect(transaction.tripId).equal('trip-id-1')
        expect(transaction.referringPathHash).equal('1234abcd')
        expect(transaction.referringTransactionGuid).equal('789')

        res.end()
        req.socket.end()
        server.close(done)
      })

      var transactionHeader = [
        '789',
        false,
        'trip-id-1',
        '1234abcd'
      ]
      var headers = {}
      headers[NEWRELIC_ID_HEADER] = hashes.obfuscateNameUsingKey('123', encKey)
      headers[NEWRELIC_TRANSACTION_HEADER] = hashes.obfuscateNameUsingKey(
        JSON.stringify(transactionHeader),
        encKey
      )

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers})
      })
    })

    it('should ignore invalid pathHash', function(done) {
      var server = http.createServer(function(req, res) {
        should.not.exist(agent.getTransaction().referringPathHash)
        res.end()
        req.socket.end()
        server.close(done)
      })

      var transactionHeader = [
        '789',
        false,
        'trip-id-1',
        {}
      ]
      var headers = {}
      headers[NEWRELIC_TRANSACTION_HEADER] = hashes.obfuscateNameUsingKey(
        JSON.stringify(transactionHeader),
        encKey
      )

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers})
      })
    })

    it('should not explode on invalid JSON', function(done) {
      var server = http.createServer(function(req, res) {
        res.end()
        req.socket.end()
        server.close(done)
      })

      var headers = {}
      headers[NEWRELIC_TRANSACTION_HEADER] = hashes.obfuscateNameUsingKey(
        'not json',
        encKey
      )

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers})
      })
    })
  })

  describe('inbound http requests when cat is disabled', function() {
    var encKey = 'gringletoes'
    var agent

    before(function() {
      agent = helper.instrumentMockedAgent(null, {
        cross_application_tracer: {enabled: false},
        encoding_key: encKey
      })
    })

    after(function() {
      helper.unloadAgent(agent)
    })

    it('should ignore cat headers', function(done) {
      var server = http.createServer(function(req, res) {
        var transaction = agent.getTransaction()
        should.not.exist(transaction.incomingCatId)
        should.not.exist(transaction.incomingAppData)
        should.not.exist(transaction.tripId)
        should.not.exist(transaction.referringPathHash)
        should.not.exist(agent.tracer.getSegment().parameters.transaction_guid)

        res.end()
        req.socket.end()
        server.close(done)
      })

      var transactionHeader = [
        '789',
        false,
        'trip-id-1',
        '1234abcd'
      ]
      var headers = {}
      headers[NEWRELIC_ID_HEADER] = hashes.obfuscateNameUsingKey('123', encKey)
      headers[NEWRELIC_APP_DATA_HEADER] = hashes.obfuscateNameUsingKey('456', encKey)
      headers[NEWRELIC_TRANSACTION_HEADER] = hashes.obfuscateNameUsingKey(
        JSON.stringify(transactionHeader),
        encKey
      )

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers})
      })
    })
  })

  describe('response headers for inbound requests when cat is enabled', function() {
    var encKey = 'gringletoes'
    var agent

    before(function() {
      agent = helper.instrumentMockedAgent(null, {
        cross_application_tracer: {enabled: true},
        encoding_key: encKey,
        trusted_account_ids: [123],
        cross_process_id: '456'
      })
    })

    after(function() {
      helper.unloadAgent(agent)
    })

    it('should set header correctly when all data is present', function(done) {
      var server = http.createServer(function(req, res) {
        agent.getTransaction().setPartialName('/abc')
        agent.getTransaction().id = '789'
        res.writeHead(200, {'Content-Length': 3})
        res.end('hi!')
      })

      var headers = {}
      headers[NEWRELIC_ID_HEADER] = hashes.obfuscateNameUsingKey('123', encKey)

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers}, function(res) {
          var data = JSON.parse(hashes.deobfuscateNameUsingKey(
            res.headers['x-newrelic-app-data'],
            encKey
          ))
          expect(data[0]).equal('456')
          expect(data[1]).equal('WebTransaction//abc')
          expect(data[4]).equal(3)
          expect(data[5]).equal('789')
          expect(data[6]).equal(false)
          res.resume()
          server.close(done)
        })
      })
    })

    it('should default Content-Length to -1', function(done) {
      var server = http.createServer(function(req, res) {
        res.end()
      })

      var headers = {}
      headers[NEWRELIC_ID_HEADER] = hashes.obfuscateNameUsingKey('123', encKey)

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers}, function(res) {
          var data = JSON.parse(hashes.deobfuscateNameUsingKey(
            res.headers['x-newrelic-app-data'],
            encKey
          ))
          expect(data[4]).equal(-1)
          res.resume()
          server.close(done)
        })
      })
    })
    it('should not set header if id not in trusted_account_ids', function(done) {
      var server = http.createServer(function(req, res) {
        res.end()
      })

      var headers = {}
      headers[NEWRELIC_ID_HEADER] = hashes.obfuscateNameUsingKey('!123', encKey)

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers}, function(res) {
          should.not.exist(res.headers['x-newrelic-app-data'])
          res.resume()
          server.close(done)
        })
      })
    })

    it('should fall back to partial name if transaction.name is not set', function(done) {
      var server = http.createServer(function(req, res) {
        agent.getTransaction().nameState.appendPath('/abc')
        res.end()
      })

      var headers = {}
      headers[NEWRELIC_ID_HEADER] = hashes.obfuscateNameUsingKey('123', encKey)

      server.listen(4123, function() {
        http.get({host : 'localhost', port : 4123, headers: headers}, function(res) {
          var data = JSON.parse(hashes.deobfuscateNameUsingKey(
            res.headers['x-newrelic-app-data'],
            encKey
          ))
          expect(data[1]).equal('WebTransaction/Nodejs/GET//abc')
          res.resume()
          server.close(done)
        })
      })
    })
  })

  describe('response headers for outbound requests when cat is enabled', function() {
    var encKey = 'gringletoes'
    var server
    var agent

    before(function(done) {
      agent = helper.instrumentMockedAgent(null, {
        cross_application_tracer: {enabled: true},
        encoding_key: encKey,
        obfuscatedId: 'o123'
      })
      http = require('http')
      server = http.createServer(function(req, res) {
        res.end()
        req.resume()
      })
      server.listen(4123, done)
    })

    after(function(done) {
      helper.unloadAgent(agent)
      server.close(done)
    })

    function addSegment() {
      var transaction = agent.getTransaction()
      transaction.type = 'web'
      transaction.baseSegment = new Segment(transaction, 'base-segment')
    }

    it('should use config.obfuscatedId as the x-newrelic-id header', function(done) {
      helper.runInTransaction(agent, function() {
        addSegment() // Add web segment so everything works properly
        var req = http.request({host: 'localhost', port: 4123}, function(res) {
          expect(req.getHeader(NEWRELIC_ID_HEADER)).equal('o123')
          res.resume()
          agent.getTransaction().end()
          done()
        })
        req.end()
      })
    })

    it('should use set x-newrelic-transaction', function(done) {
      helper.runInTransaction(agent, function() {
        addSegment() // Add web segment so everything works properly
        var transaction = agent.getTransaction()
        transaction.name = '/abc'
        transaction.referringPathHash = 'h/def'
        transaction.id = '456'
        transaction.tripId = '789'
        var pathHash = hashes.calculatePathHash(
          agent.config.applications()[0],
          transaction.name,
          transaction.referringPathHash
        )

        var req = http.get({host : 'localhost', port : 4123}, function(res) {
          var data = JSON.parse(hashes.deobfuscateNameUsingKey(
            req.getHeader(NEWRELIC_TRANSACTION_HEADER),
            encKey
          ))
          expect(data[0]).equal('456')
          expect(data[1]).equal(false)
          expect(data[2]).equal('789')
          expect(data[3]).equal(pathHash)
          res.resume()
          transaction.end()
          done()
        })
        req.end()
      })
    })

    it('should use transaction.id if transaction.tripId is not set', function(done) {
      helper.runInTransaction(agent, function() {
        addSegment() // Add web segment so everything works properly
        var transaction = agent.getTransaction()
        transaction.id = '456'
        transaction.tripId = null

        var req = http.get({host : 'localhost', port : 4123}, function(res) {
          var data = JSON.parse(hashes.deobfuscateNameUsingKey(
            req.getHeader(NEWRELIC_TRANSACTION_HEADER),
            encKey
          ))
          expect(data[2]).equal('456')
          res.resume()
          transaction.end()
          done()
        })
        req.end()
      })
    })

    it('should use partialName if transaction.name is not set', function(done) {
      helper.runInTransaction(agent, function() {
        addSegment() // Add web segment so everything works properly
        var transaction = agent.getTransaction()
        transaction.url = '/xyz'
        transaction.nameState.appendPath('/xyz')
        transaction.name = null
        transaction.referringPathHash = 'h/def'
        var pathHash = hashes.calculatePathHash(
          agent.config.applications()[0],
          transaction.getFullName(),
          transaction.referringPathHash
        )

        var req = http.get({host : 'localhost', port : 4123}, function(res) {
          var data = JSON.parse(hashes.deobfuscateNameUsingKey(
            req.getHeader(NEWRELIC_TRANSACTION_HEADER),
            encKey
          ))
          expect(data[3]).equal(pathHash)
          res.resume()
          transaction.end()
          done()
        })
        req.end()
      })
    })
    it('should save current pathHash', function(done) {
      helper.runInTransaction(agent, function() {
        addSegment() // Add web segment so everything works properly
        var transaction = agent.getTransaction()
        transaction.name = '/xyz'
        transaction.referringPathHash = 'h/def'
        var pathHash = hashes.calculatePathHash(
          agent.config.applications()[0],
          transaction.name,
          transaction.referringPathHash
        )

        http.get({host : 'localhost', port : 4123}, function(res) {
          expect(transaction.pathHashes).deep.equal([pathHash])
          res.resume()
          transaction.end ()
          done()
        }).end()
      })
    })
  })

  describe('request headers for outbound request', function() {
    var agent
    it('should preserve headers regardless of format', function(done) {
      var encKey = 'gringletoes'

      agent = helper.instrumentMockedAgent(null, {
        cross_application_tracer: {enabled: true},
        encoding_key: encKey,
        obfuscatedId: 'o123'
      })

      var http = require('http')
      var had_expect = 0

      var server = http.createServer(function(req, res) {
        if (req.headers.expect) {
          had_expect++
          expect(req.headers.expect).equal('100-continue')
        }
        expect(req.headers.a).equal('1')
        expect(req.headers.b).equal('2')
        expect(req.headers['x-newrelic-id']).equal('o123')
        res.end()
        req.resume()
      })

      server.listen(4123, function() {
        helper.runInTransaction(agent, obj_request)
      })

      function obj_request() {
        addSegment()
        var req = http.request(
          {host : 'localhost', port : 4123, headers: {a: 1, b: 2}},
          function(res) {
            res.resume()
            array_request()
          }
        )
        req.end()
      }

      function array_request() {
        addSegment()
        var req = http.request(
          {host : 'localhost', port : 4123, headers: [['a', 1], ['b', 2]]},
          function(res) {
            res.resume()
            expect_request()
          }
        )
        req.end()
      }

      function expect_request() {
        addSegment()
        var req = http.request({
          host: 'localhost',
          port: 4123,
          headers: {a: 1, b: 2, expect: '100-continue'}
        }, function(res) {
          res.resume()
          end_test()
        })
        req.end()
      }

      function end_test() {
        expect(had_expect).equal(1)
        agent.getTransaction().end()
        helper.unloadAgent(agent)
        server.close(done)
      }
    })

    function addSegment() {
      var transaction = agent.getTransaction()
      transaction.type = 'web'
      transaction.baseSegment = new Segment(transaction, 'base-segment')
    }
  })
})
