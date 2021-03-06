import { promises as fs } from 'fs';
import { register, Counter, Gauge } from 'prom-client';
import Bluebird from 'bluebird';
import path from 'path';
import _ from 'lodash';
import satpam from 'satpam';
import express from 'express';
import { Server } from 'http';

import GooglePubSubConfig from './interface/google-pub-sub-config';
import AWSQueueConfig from './interface/aws-queue-config';
import RegisterConfig from './interface/register-config';
import RegisterCommonConfig from './interface/register-common-config';
import MetricCommonConfig from './interface/metric-common-config';

import QueueService from './enum/queue-service';

import UnsupportedQueueServiceError from './error/unsupported-queue-service-error';
import ValidationError from './error/validation-error';
import DuplicateMetricDeclarationError from './error/duplicate-metric-declaration-error';

import GooglePubSub from './queue/google-pub-sub';
import AWSQueue from './queue/aws-queue';
import Queue from './queue/queue';
import Metric from './metric/metric';
import Logger from './common/logger';

import {
  FIRST_LAYER_SPECIFICATION_VALIDATION_RULE,
  CREDENTIAL_VALIDATION_RULE,
  FIRST_LAYER_METRIC_SPECIFICATION_VALIDATION_RULE,
  METRIC_VALIDATION_RULE
} from './constant/specification';

class Orchestrator {
  /**
   * Array of queues.
   */
  readonly queues: Array<Queue>;

  /**
   * Logger to print to console.
   */
  readonly logger: Logger;

  /**
   * Credentials to initiate each queue.
   */
  readonly credential: {
    [key in keyof typeof QueueService]: GooglePubSubConfig|AWSQueueConfig
  };

  /**
   * Registered metric by name.
   */
  metricByName: {
    [key: string]: Counter<any>|Gauge<any>
  }

  /**
   * Get all file paths recursively from a directory path.
   *
   * @param {string} directoryPath
   *
   * @return {Array<string>}
   */
  static async getAllFilePaths(directoryPath: string): Promise<Array<string>> {
    const filePaths = [];
    const fileNames = await fs.readdir(directoryPath);

    await Bluebird.each(fileNames, async (fileName) => {
      const candidatePath = path.join(directoryPath, '/', fileName);
      const pathStatus = await fs.stat(candidatePath);

      if (pathStatus.isDirectory()) {
        const additionalFilePaths = await Orchestrator.getAllFilePaths(candidatePath);

        filePaths.push(...additionalFilePaths);
      } else {
        filePaths.push(candidatePath);
      }
    });

    return filePaths;
  }

  /**
   * Read all of queue specifications from file paths and/or directory paths.
   *
   * @param {RegisterCommonConfig} config
   *
   * @return {Promise<Array<{
   *   [key: string]: any
   * }>>}
   */
  static async getAllSpecificationsFromPaths(config: RegisterCommonConfig): Promise<Array<{
    [key: string]: any
  }>> {
    const directoryPaths = _.defaultTo(config.directoryPaths, []);
    const filePaths = _.defaultTo(config.filePaths, []);

    const directoryFilePaths = await Bluebird.reduce(directoryPaths, async (acc, directoryPath) => {
      return _.concat(acc, await Orchestrator.getAllFilePaths(directoryPath));
    }, []);

    const allFilePaths = _.chain(filePaths).concat(directoryFilePaths).compact().value();

    return Bluebird.mapSeries(allFilePaths, async (filePath) => {
      const buffer = await fs.readFile(filePath);
      const specInString = buffer.toString('utf8');

      return {
        ...JSON.parse(specInString),
        filePath
      };
    });
  }

  /**
   * Validate metric specifications to make sure it is in valid format.
   *
   * @param {any} specification
   *
   * @return {
   *   [key: number]: any
   * } - the validation message
   */
  static validateMetricSpecification(specification: any): {
    [key: string]: any
  } {
    const firstLayerValidation = satpam.validate(FIRST_LAYER_METRIC_SPECIFICATION_VALIDATION_RULE, specification);

    const metricValidationMessages = _.map(_.get(specification, 'metrics'), (metricSpecification) => {
      return satpam.validate(METRIC_VALIDATION_RULE, metricSpecification).messages;
    });

    const filteredMetricValidationMessages = _.filter(metricValidationMessages, (message) => !_.isEmpty(message));

    if (_.isEmpty(filteredMetricValidationMessages)) {
      return firstLayerValidation.messages;
    }

    const metricValidationMessage = {
      metrics: {
        elementOfArray: { ...metricValidationMessages } // key: index array, value: validation message
      }
    };

    return _.merge(firstLayerValidation.messages, metricValidationMessage);
  }

  /**
   * Extract service names that are used from all of the specifications.
   *
   * @param {Array<object>} specifications
   *
   * @return {Array<string>}
   */
  static extractServiceNamesFromSpecifications(specifications: Array<{
    [key: string]: any
  }>): Array<string> {
    return _.chain(specifications)
      .map((specification) => _.get(specification, 'service'))
      .compact()
      .uniq()
      .value();
  }

  constructor(credential: {
    [key in keyof typeof QueueService]: GooglePubSubConfig|AWSQueueConfig
  }, logger?: any) {
    this.credential = credential;
    this.queues = [];
    this.logger = new Logger(logger);
    this.metricByName = {};
  }

  /**
   * Get queue instance.
   *
   * @param {any} specification
   *
   * @return {AWSQueue|GooglePubSub|UnsupportedQueueServiceError}
   */
  getQueue(specification: any): GooglePubSub|AWSQueue {
    const defaultConfig = {
      ...this.credential[specification.service],
      subscriptionName: specification.subscription,
      metricConfigs: specification.metrics,
      pollConfig: {
        consumerCount: specification.consumerCount,
        concurrency: specification.concurrency
      },
      metricByName: this.metricByName,
      logger: this.logger
    };

    if (specification.service === QueueService.AWS) {
      return new AWSQueue(defaultConfig);
    } else if (specification.service === QueueService.GooglePubSub) {
      return new GooglePubSub(defaultConfig);
    } else {
      throw new UnsupportedQueueServiceError(`Queue service ${specification.service} is not supported.`);
    }
  }

  /**
   * Validate queue specification to make sure it is in valid format.
   *
   * @param {any} specification
   *
   * @return {
   *   [key: string]: any
   * } - the validation message
   */
  validateQueueSpecification(specification: any): {
    [key: string]: any
  } {
    const firstLayerValidation = satpam.validate(FIRST_LAYER_SPECIFICATION_VALIDATION_RULE, specification);

    const metricNameSet = new Set();

    const metricValidationMessages = _.map(_.get(specification, 'metrics'), (metric) => {
      return Metric.validateMetricConfig(metric, this.metricByName, metricNameSet as Set<string>);
    });

    const filteredMetricValidationMessages = _.filter(metricValidationMessages, (message) => !_.isEmpty(message));

    if (_.isEmpty(filteredMetricValidationMessages)) {
      return firstLayerValidation.messages;
    }

    const metricValidationMessage = {
      metrics: {
        elementOfArray: { ...metricValidationMessages } // key: index array, value: validation message
      }
    };

    return _.merge(firstLayerValidation.messages, metricValidationMessage);
  }

  /**
   * Validate credential passed to include credential for service name specified in serviceNames.
   *
   * @param {Array<string>} serviceNames
   *
   * @return {
   *   [key: string]: any
   * } - the validation message
   */
  validateCredential(serviceNames: Array<string>): {
    [key: string]: any
  } {
    const validationRule = _.reduce(serviceNames, (acc, serviceName) => {
      return {
        ...acc,
        [serviceName]: CREDENTIAL_VALIDATION_RULE[serviceName]
      }
    }, {});

    return satpam.validate(validationRule, this.credential).messages;
  }

  /**
   * Register queue according to the specification.
   *
   * @param {any} specification
   */
  registerQueue(specification: any): void {
    const queue = this.getQueue(specification);

    this.queues.push(queue);
  }

  /**
   * Register metric according to the specification.
   *
   * @param {MetricCommonConfig} metricSpecification
   */
  registerMetric(metricSpecification: MetricCommonConfig): void {
    if (this.metricByName[metricSpecification.name]) {
      throw new DuplicateMetricDeclarationError(`Metric ${metricSpecification.name} has been declared previously.`);
    }

    this.metricByName[metricSpecification.name] = Metric.getPromMetric(metricSpecification);
  }

  /**
   * Start polling in queues defined in specifications.
   * Stop all of the queues immediately if there is an error when starting one of the queues.
   */
  async startQueues(): Promise<void> {
    return Bluebird.map(this.queues, (queue) => {
      return Bluebird.resolve()
        .then(() => queue.poll())
        .catch((error) => {
          this.logger.error(`Error when polling ${queue.queueService} queue. Poll config: ${JSON.stringify(queue.pollConfig)}. Error: ${error.message || JSON.stringify(error.stack)}`);

          throw error;
        });
    }, { concurrency: this.queues.length })
      .catch(async (error) => {
        this.logger.info('Stopping all queues.');

        await this.stopQueues();

        throw error;
      });
  }

  /**
   * Stop all of the queues from polling.
   */
  async stopQueues(): Promise<void> {
    for (const queue of this.queues) {
      await queue.close();
    }
  }

  /**
   * Register all of the metrics according to the specifications defined in
   * file paths and/or directory paths.
   *
   * @param {RegisterConfig} config
   */
  async registerMetrics(config: RegisterConfig): Promise<void> {
    const specifications = await Orchestrator.getAllSpecificationsFromPaths({
      directoryPaths: config.metricDirectoryPaths,
      filePaths: config.metricFilePaths
    });

    const specificationValidationMessages = _.reduce(specifications, (acc, specification) => {
      const validationMessage = Orchestrator.validateMetricSpecification(specification);

      if (_.isEmpty(validationMessage)) {
        return acc;
      }

      return _.concat(acc, {
        filePath: specification.filePath,
        message: validationMessage
      });
    }, []);

    if (!_.isEmpty(specificationValidationMessages)) {
      throw new ValidationError('Metric specifications have invalid format.', {
        messages: specificationValidationMessages
      });
    }

    for (const specification of specifications) {
      for (const metricSpecification of specification.metrics) {
        this.registerMetric(metricSpecification as MetricCommonConfig);
      }
    }
  }

  /**
   * Register all of the queues according to the specifications defined in
   * file paths and/or directory paths.
   *
   * @param {RegisterConfig} config
   */
  async registerQueues(config: RegisterConfig): Promise<void> {
    const specifications = await Orchestrator.getAllSpecificationsFromPaths({
      directoryPaths: config.queueDirectoryPaths,
      filePaths: config.queueFilePaths
    });

    const serviceNames = Orchestrator.extractServiceNamesFromSpecifications(specifications);

    const credentialValidationMessage = this.validateCredential(serviceNames);

    if (!_.isEmpty(credentialValidationMessage)) {
      throw new ValidationError('Credentials passed have invalid format.', {
        message: credentialValidationMessage
      });
    }

    const specificationValidationMessages = _.reduce(specifications, (acc, specification) => {
      const validationMessage = this.validateQueueSpecification(specification);

      if (_.isEmpty(validationMessage)) {
        return acc;
      }

      return _.concat(acc, {
        filePath: specification.filePath,
        message: validationMessage
      });
    }, []);

    if (!_.isEmpty(specificationValidationMessages)) {
      throw new ValidationError('Queue specifications have invalid format.', {
        messages: specificationValidationMessages
      });
    }

    for (const specification of specifications) {
      this.registerQueue(specification);
    }
  }

  /**
   * Register all of the metrics and queues according to the specifications defined in
   * file paths and/or directory paths.
   *
   * @param {RegisterConfig} config
   */
  async register(config: RegisterConfig): Promise<void> {
    await this.registerMetrics(config);
    await this.registerQueues(config);
  }

  /**
   * Start the HTTP listener to serve the result metrics
   * at specific port and specific URL.
   *
   * @param {number} port
   * @param {url} url
   */
  start(port: number, url: string) {
    const app = express();

    const http = new Server(app);

    app.get(url, async (req, res) => {
      res.set('Content-Type', register.contentType);

      return res.send(await register.metrics());
    });

    http.listen(port, () => {
      this.logger.info(`Listening on port: ${port}`);
    });
  }
}

export = Orchestrator;
