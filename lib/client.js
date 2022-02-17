const { EventEmitter } = require('events');
const { makeEscape } = require('./util/string');

const QueryBuilder = require('./query/querybuilder');
const QueryCompiler = require('./query/querycompiler');
const SchemaBuilder = require('./schema/builder');
const SchemaCompiler = require('./schema/compiler');
const TableBuilder = require('./schema/tablebuilder');
const TableCompiler = require('./schema/tablecompiler');
const ColumnBuilder = require('./schema/columnbuilder');
const ColumnCompiler = require('./schema/columncompiler');
const { outputQuery, unwrapRaw } = require('./formatter/wrappingFormatter');
const { compileCallback } = require('./formatter/formatterUtils');
const Raw = require('./raw');
const Ref = require('./ref');
const Formatter = require('./formatter');
const Logger = require('./logger');
const ViewBuilder = require('./schema/viewbuilder.js');
const ViewCompiler = require('./schema/viewcompiler.js');
const isPlainObject = require('lodash/isPlainObject');

class Client extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.logger = new Logger(config);

    if (config.version) {
      this.version = config.version;
    }

    this.valueForUndefined = this.raw('DEFAULT');
    if (config.useNullAsDefault) {
      this.valueForUndefined = null;
    }
  }
  formatter(builder) {
    return new Formatter(this, builder);
  }

  queryBuilder() {
    return new QueryBuilder(this);
  }

  queryCompiler(builder, formatter) {
    return new QueryCompiler(this, builder, formatter);
  }

  schemaBuilder() {
    return new SchemaBuilder(this);
  }

  schemaCompiler(builder) {
    return new SchemaCompiler(this, builder);
  }

  tableBuilder(type, tableName, tableNameLike, fn) {
    return new TableBuilder(this, type, tableName, tableNameLike, fn);
  }

  viewBuilder(type, viewBuilder, fn) {
    return new ViewBuilder(this, type, viewBuilder, fn);
  }

  tableCompiler(tableBuilder) {
    return new TableCompiler(this, tableBuilder);
  }

  viewCompiler(viewCompiler) {
    return new ViewCompiler(this, viewCompiler);
  }

  columnBuilder(tableBuilder, type, args) {
    return new ColumnBuilder(this, tableBuilder, type, args);
  }

  columnCompiler(tableBuilder, columnBuilder) {
    return new ColumnCompiler(this, tableBuilder, columnBuilder);
  }

  transaction(container, config, outerTx) {
    throw new Error('Transaction not implemented');
  }

  raw() {
    return new Raw(this).set(...arguments);
  }

  ref() {
    return new Ref(this, ...arguments);
  }
  query(connection, queryParam) {
    throw new Error('Query execution not implemented');
  }

  stream(connection, queryParam, stream, options) {
    throw new Error('Query execution not implemented');
  }

  prepBindings(bindings) {
    return bindings;
  }

  positionBindings(sql) {
    return sql;
  }

  postProcessResponse(resp, queryContext) {
    if (this.config.postProcessResponse) {
      return this.config.postProcessResponse(resp, queryContext);
    }
    return resp;
  }

  wrapIdentifier(value, queryContext) {
    return this.customWrapIdentifier(
      value,
      this.wrapIdentifierImpl,
      queryContext
    );
  }

  customWrapIdentifier(value, origImpl, queryContext) {
    if (this.config.wrapIdentifier) {
      return this.config.wrapIdentifier(value, origImpl, queryContext);
    }
    return origImpl(value);
  }

  wrapIdentifierImpl(value) {
    return value !== '*' ? `"${value.replace(/"/g, '""')}"` : '*';
  }

  initializeDriver() {
    try {
      this.driver = this._driver();
    } catch (e) {
      const message = `Knex: run\n$ npm install ${this.driverName} --save`;
      this.logger.error(`${message}\n${e.message}\n${e.stack}`);
      throw new Error(`${message}\n${e.message}`);
    }
  }

  poolDefaults() {
    return { min: 2, max: 10, propagateCreateError: true };
  }

  getPoolSettings(poolConfig) {
    throw new Error('Pool not implemented');
  }

  initializePool(config = this.config) {
    throw new Error('Pool not implemented');
  }

  validateConnection(connection) {
    return true;
  }

  // Acquire a connection from the pool.
  async acquireConnection() {
    throw new Error('Database connection not implemented');
  }

  // Releases a connection back to the connection pool,
  // returning a promise resolved when the connection is released.
  releaseConnection(connection) {
    throw new Error('Database connection not implemented');
  }

  // Destroy the current connection pool for the client.
  async destroy(callback) {
    try {
      if (this.pool && this.pool.destroy) {
        await this.pool.destroy();
      }
      this.pool = undefined;

      if (typeof callback === 'function') {
        callback();
      }
    } catch (err) {
      if (typeof callback === 'function') {
        return callback(err);
      }
      throw err;
    }
  }

  // Return the database being used by this client.
  database() {
    return this.connectionSettings.database;
  }

  toString() {
    return '[object KnexClient]';
  }

  assertCanCancelQuery() {
    if (!this.canCancelQuery) {
      throw new Error('Query cancelling not supported for this dialect');
    }
  }

  cancelQuery() {
    throw new Error('Query cancelling not supported for this dialect');
  }

  // Formatter part

  alias(first, second) {
    return first + ' as ' + second;
  }

  // Checks whether a value is a function... if it is, we compile it
  // otherwise we check whether it's a raw
  parameter(value, builder, bindingsHolder) {
    if (typeof value === 'function') {
      return outputQuery(
        compileCallback(value, undefined, this, bindingsHolder),
        true,
        builder,
        this
      );
    }
    return unwrapRaw(value, true, builder, this, bindingsHolder) || '?';
  }

  // Turns a list of values into a list of ?'s, joining them with commas unless
  // a "joining" value is specified (e.g. ' and ')
  parameterize(values, notSetValue, builder, bindingsHolder) {
    if (typeof values === 'function')
      return this.parameter(values, builder, bindingsHolder);
    values = Array.isArray(values) ? values : [values];
    let str = '',
      i = -1;
    while (++i < values.length) {
      if (i > 0) str += ', ';
      let value = values[i];
      // json columns can have object in values.
      if (isPlainObject(value)) {
        value = JSON.stringify(value);
      }
      str += this.parameter(
        value === undefined ? notSetValue : value,
        builder,
        bindingsHolder
      );
    }
    return str;
  }

  // Formats `values` into a parenthesized list of parameters for a `VALUES`
  // clause.
  //
  // [1, 2]                  -> '(?, ?)'
  // [[1, 2], [3, 4]]        -> '((?, ?), (?, ?))'
  // knex('table')           -> '(select * from "table")'
  // knex.raw('select ?', 1) -> '(select ?)'
  //
  values(values, builder, bindingsHolder) {
    if (Array.isArray(values)) {
      if (Array.isArray(values[0])) {
        return `(${values
          .map(
            (value) =>
              `(${this.parameterize(
                value,
                undefined,
                builder,
                bindingsHolder
              )})`
          )
          .join(', ')})`;
      }
      return `(${this.parameterize(
        values,
        undefined,
        builder,
        bindingsHolder
      )})`;
    }

    if (values && values.isRawInstance) {
      return `(${this.parameter(values, builder, bindingsHolder)})`;
    }

    return this.parameter(values, builder, bindingsHolder);
  }

  processPassedConnection(connection) {
    // Default implementation is noop
  }

  toPathForJson(jsonPath) {
    // By default, we want a json path, so if this function is not overriden,
    // we return the path.
    return jsonPath;
  }
}

Object.assign(Client.prototype, {
  _escapeBinding: makeEscape({
    escapeString(str) {
      return `'${str.replace(/'/g, "''")}'`;
    },
  }),

  canCancelQuery: false,
});

module.exports = Client;
