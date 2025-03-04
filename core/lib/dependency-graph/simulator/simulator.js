/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import * as LH from '../../../../types/lh.js';
import {BaseNode} from '../base-node.js';
import {TcpConnection} from './tcp-connection.js';
import {ConnectionPool} from './connection-pool.js';
import {DNSCache} from './dns-cache.js';
import {SimulatorTimingMap} from './simulator-timing-map.js';
import * as constants from '../../../config/constants.js';

const mobileSlow4G = constants.throttling.mobileSlow4G;

/** @typedef {import('../base-node.js').Node} Node */
/** @typedef {import('../network-node.js').NetworkNode} NetworkNode */
/** @typedef {import('../cpu-node.js').CPUNode} CpuNode */
/** @typedef {import('./simulator-timing-map.js').CpuNodeTimingComplete | import('./simulator-timing-map.js').NetworkNodeTimingComplete} CompleteNodeTiming */
/** @typedef {import('./simulator-timing-map.js').ConnectionTiming} ConnectionTiming */

// see https://cs.chromium.org/search/?q=kDefaultMaxNumDelayableRequestsPerClient&sq=package:chromium&type=cs
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 10;
// layout tasks tend to be less CPU-bound and do not experience the same increase in duration
const DEFAULT_LAYOUT_TASK_MULTIPLIER = 0.5;
// if a task takes more than 10 seconds it's usually a sign it isn't actually CPU bound and we're overestimating
const DEFAULT_MAXIMUM_CPU_TASK_DURATION = 10000;

const NodeState = {
  NotReadyToStart: 0,
  ReadyToStart: 1,
  InProgress: 2,
  Complete: 3,
};

/** @type {Record<NetworkNode['record']['priority'], number>} */
const PriorityStartTimePenalty = {
  VeryHigh: 0,
  High: 0.25,
  Medium: 0.5,
  Low: 1,
  VeryLow: 2,
};

/** @type {Map<string, Map<Node, CompleteNodeTiming>>} */
const ALL_SIMULATION_NODE_TIMINGS = new Map();

class Simulator {
  /**
   * @param {LH.Gatherer.Simulation.Options} [options]
   */
  constructor(options) {
    /** @type {Required<LH.Gatherer.Simulation.Options>} */
    this._options = Object.assign(
      {
        rtt: mobileSlow4G.rttMs,
        throughput: mobileSlow4G.throughputKbps * 1024,
        maximumConcurrentRequests: DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
        cpuSlowdownMultiplier: mobileSlow4G.cpuSlowdownMultiplier,
        layoutTaskMultiplier: DEFAULT_LAYOUT_TASK_MULTIPLIER,
        additionalRttByOrigin: new Map(),
        serverResponseTimeByOrigin: new Map(),
      },
      options
    );

    this._rtt = this._options.rtt;
    this._throughput = this._options.throughput;
    this._maximumConcurrentRequests = Math.max(Math.min(
      TcpConnection.maximumSaturatedConnections(this._rtt, this._throughput),
      this._options.maximumConcurrentRequests
    ), 1);
    this._cpuSlowdownMultiplier = this._options.cpuSlowdownMultiplier;
    this._layoutTaskMultiplier = this._cpuSlowdownMultiplier * this._options.layoutTaskMultiplier;
    /** @type {Array<Node>} */
    this._cachedNodeListByStartPosition = [];

    // Properties reset on every `.simulate` call but duplicated here for type checking
    this._flexibleOrdering = false;
    this._nodeTimings = new SimulatorTimingMap();
    /** @type {Map<string, number>} */
    this._numberInProgressByType = new Map();
    /** @type {Record<number, Set<Node>>} */
    this._nodes = {};
    this._dns = new DNSCache({rtt: this._rtt});
    /** @type {ConnectionPool} */
    // @ts-expect-error
    this._connectionPool = null;

    if (!Number.isFinite(this._rtt)) throw new Error(`Invalid rtt ${this._rtt}`);
    if (!Number.isFinite(this._throughput)) throw new Error(`Invalid rtt ${this._throughput}`);
  }

  /** @return {number} */
  get rtt() {
    return this._rtt;
  }

  /**
   * @param {Node} graph
   */
  _initializeConnectionPool(graph) {
    /** @type {LH.Artifacts.NetworkRequest[]} */
    const records = [];
    graph.getRootNode().traverse(node => {
      if (node.type === BaseNode.TYPES.NETWORK) {
        records.push(node.record);
      }
    });

    this._connectionPool = new ConnectionPool(records, this._options);
  }

  /**
   * Initializes the various state data structures such _nodeTimings and the _node Sets by state.
   */
  _initializeAuxiliaryData() {
    this._nodeTimings = new SimulatorTimingMap();
    this._numberInProgressByType = new Map();

    this._nodes = {};
    this._cachedNodeListByStartPosition = [];
    // NOTE: We don't actually need *all* of these sets, but the clarity that each node progresses
    // through the system is quite nice.
    for (const state of Object.values(NodeState)) {
      this._nodes[state] = new Set();
    }
  }

  /**
   * @param {string} type
   * @return {number}
   */
  _numberInProgress(type) {
    return this._numberInProgressByType.get(type) || 0;
  }

  /**
   * @param {Node} node
   * @param {number} queuedTime
   */
  _markNodeAsReadyToStart(node, queuedTime) {
    const nodeStartPosition = Simulator._computeNodeStartPosition(node);
    const firstNodeIndexWithGreaterStartPosition = this._cachedNodeListByStartPosition
      .findIndex(candidate => Simulator._computeNodeStartPosition(candidate) > nodeStartPosition);
    const insertionIndex = firstNodeIndexWithGreaterStartPosition === -1 ?
      this._cachedNodeListByStartPosition.length : firstNodeIndexWithGreaterStartPosition;
    this._cachedNodeListByStartPosition.splice(insertionIndex, 0, node);

    this._nodes[NodeState.ReadyToStart].add(node);
    this._nodes[NodeState.NotReadyToStart].delete(node);
    this._nodeTimings.setReadyToStart(node, {queuedTime});
  }

  /**
   * @param {Node} node
   * @param {number} startTime
   */
  _markNodeAsInProgress(node, startTime) {
    const indexOfNodeToStart = this._cachedNodeListByStartPosition.indexOf(node);
    this._cachedNodeListByStartPosition.splice(indexOfNodeToStart, 1);

    this._nodes[NodeState.InProgress].add(node);
    this._nodes[NodeState.ReadyToStart].delete(node);
    this._numberInProgressByType.set(node.type, this._numberInProgress(node.type) + 1);
    this._nodeTimings.setInProgress(node, {startTime});
  }

  /**
   * @param {Node} node
   * @param {number} endTime
   * @param {ConnectionTiming} [connectionTiming] Optional network connection information.
   */
  _markNodeAsComplete(node, endTime, connectionTiming) {
    this._nodes[NodeState.Complete].add(node);
    this._nodes[NodeState.InProgress].delete(node);
    this._numberInProgressByType.set(node.type, this._numberInProgress(node.type) - 1);
    this._nodeTimings.setCompleted(node, {endTime, connectionTiming});

    // Try to add all its dependents to the queue
    for (const dependent of node.getDependents()) {
      // Skip dependent node if one of its dependencies hasn't finished yet
      const dependencies = dependent.getDependencies();
      if (dependencies.some(dep => !this._nodes[NodeState.Complete].has(dep))) continue;

      // Otherwise add it to the queue
      this._markNodeAsReadyToStart(dependent, endTime);
    }
  }

  /**
   * @param {LH.Artifacts.NetworkRequest} record
   * @return {?TcpConnection}
   */
  _acquireConnection(record) {
    return this._connectionPool.acquire(record, {
      ignoreConnectionReused: this._flexibleOrdering,
    });
  }

  /**
   * @return {Node[]}
   */
  _getNodesSortedByStartPosition() {
    // Make a copy so we don't skip nodes due to concurrent modification
    return Array.from(this._cachedNodeListByStartPosition);
  }

  /**
   * @param {Node} node
   * @param {number} totalElapsedTime
   */
  _startNodeIfPossible(node, totalElapsedTime) {
    if (node.type === BaseNode.TYPES.CPU) {
      // Start a CPU task if there's no other CPU task in process
      if (this._numberInProgress(node.type) === 0) {
        this._markNodeAsInProgress(node, totalElapsedTime);
      }

      return;
    }

    if (node.type !== BaseNode.TYPES.NETWORK) throw new Error('Unsupported');

    // If a network request is connectionless, we can always start it, so skip the connection checks
    if (!node.isConnectionless) {
      // Start a network request if we're not at max requests and a connection is available
      const numberOfActiveRequests = this._numberInProgress(node.type);
      if (numberOfActiveRequests >= this._maximumConcurrentRequests) return;
      const connection = this._acquireConnection(node.record);
      if (!connection) return;
    }

    this._markNodeAsInProgress(node, totalElapsedTime);
  }

  /**
   * Updates each connection in use with the available throughput based on the number of network requests
   * currently in flight.
   */
  _updateNetworkCapacity() {
    const inFlight = this._numberInProgress(BaseNode.TYPES.NETWORK);
    if (inFlight === 0) return;

    for (const connection of this._connectionPool.connectionsInUse()) {
      connection.setThroughput(this._throughput / inFlight);
    }
  }

  /**
   * Estimates the number of milliseconds remaining given current condidtions before the node is complete.
   * @param {Node} node
   * @return {number}
   */
  _estimateTimeRemaining(node) {
    if (node.type === BaseNode.TYPES.CPU) {
      return this._estimateCPUTimeRemaining(node);
    } else if (node.type === BaseNode.TYPES.NETWORK) {
      return this._estimateNetworkTimeRemaining(node);
    } else {
      throw new Error('Unsupported');
    }
  }

  /**
   * @param {CpuNode} cpuNode
   * @return {number}
   */
  _estimateCPUTimeRemaining(cpuNode) {
    const timingData = this._nodeTimings.getCpuStarted(cpuNode);
    const multiplier = cpuNode.didPerformLayout()
      ? this._layoutTaskMultiplier
      : this._cpuSlowdownMultiplier;
    const totalDuration = Math.min(
      Math.round(cpuNode.event.dur / 1000 * multiplier),
      DEFAULT_MAXIMUM_CPU_TASK_DURATION
    );
    const estimatedTimeElapsed = totalDuration - timingData.timeElapsed;
    this._nodeTimings.setCpuEstimated(cpuNode, {estimatedTimeElapsed});
    return estimatedTimeElapsed;
  }

  /**
   * @param {NetworkNode} networkNode
   * @return {number}
   */
  _estimateNetworkTimeRemaining(networkNode) {
    const record = networkNode.record;
    const timingData = this._nodeTimings.getNetworkStarted(networkNode);

    let timeElapsed = 0;
    if (networkNode.fromDiskCache) {
      // Rough access time for seeking to location on disk and reading sequentially.
      // 8ms per seek + 20ms/MB
      // @see http://norvig.com/21-days.html#answers
      const sizeInMb = (record.resourceSize || 0) / 1024 / 1024;
      timeElapsed = 8 + 20 * sizeInMb - timingData.timeElapsed;
    } else if (networkNode.isNonNetworkProtocol) {
      // Estimates for the overhead of a data URL in Chromium and the decoding time for base64-encoded data.
      // 2ms per request + 10ms/MB
      // @see traces on https://dopiaza.org/tools/datauri/examples/index.php
      const sizeInMb = (record.resourceSize || 0) / 1024 / 1024;
      timeElapsed = 2 + 10 * sizeInMb - timingData.timeElapsed;
    } else {
      const connection = this._connectionPool.acquireActiveConnectionFromRecord(record);
      const dnsResolutionTime = this._dns.getTimeUntilResolution(record, {
        requestedAt: timingData.startTime,
        shouldUpdateCache: true,
      });
      const timeAlreadyElapsed = timingData.timeElapsed;
      const calculation = connection.simulateDownloadUntil(
        record.transferSize - timingData.bytesDownloaded,
        {timeAlreadyElapsed, dnsResolutionTime, maximumTimeToElapse: Infinity}
      );

      timeElapsed = calculation.timeElapsed;
    }

    const estimatedTimeElapsed = timeElapsed + timingData.timeElapsedOvershoot;
    this._nodeTimings.setNetworkEstimated(networkNode, {estimatedTimeElapsed});
    return estimatedTimeElapsed;
  }

  /**
   * Computes and returns the minimum estimated completion time of the nodes currently in progress.
   * @return {number}
   */
  _findNextNodeCompletionTime() {
    let minimumTime = Infinity;
    for (const node of this._nodes[NodeState.InProgress]) {
      minimumTime = Math.min(minimumTime, this._estimateTimeRemaining(node));
    }

    return minimumTime;
  }

  /**
   * Given a time period, computes the progress toward completion that the node made durin that time.
   * @param {Node} node
   * @param {number} timePeriodLength
   * @param {number} totalElapsedTime
   */
  _updateProgressMadeInTimePeriod(node, timePeriodLength, totalElapsedTime) {
    const timingData = this._nodeTimings.getInProgress(node);
    const isFinished = timingData.estimatedTimeElapsed === timePeriodLength;

    if (node.type === BaseNode.TYPES.CPU || node.isConnectionless) {
      return isFinished
        ? this._markNodeAsComplete(node, totalElapsedTime)
        : (timingData.timeElapsed += timePeriodLength);
    }

    if (node.type !== BaseNode.TYPES.NETWORK) throw new Error('Unsupported');
    if (!('bytesDownloaded' in timingData)) throw new Error('Invalid timing data');

    const record = node.record;
    const connection = this._connectionPool.acquireActiveConnectionFromRecord(record);
    const dnsResolutionTime = this._dns.getTimeUntilResolution(record, {
      requestedAt: timingData.startTime,
      shouldUpdateCache: true,
    });
    const calculation = connection.simulateDownloadUntil(
      record.transferSize - timingData.bytesDownloaded,
      {
        dnsResolutionTime,
        timeAlreadyElapsed: timingData.timeElapsed,
        maximumTimeToElapse: timePeriodLength - timingData.timeElapsedOvershoot,
      }
    );

    connection.setCongestionWindow(calculation.congestionWindow);
    connection.setH2OverflowBytesDownloaded(calculation.extraBytesDownloaded);

    if (isFinished) {
      connection.setWarmed(true);
      this._connectionPool.release(record);
      this._markNodeAsComplete(node, totalElapsedTime, calculation.connectionTiming);
    } else {
      timingData.timeElapsed += calculation.timeElapsed;
      timingData.timeElapsedOvershoot += calculation.timeElapsed - timePeriodLength;
      timingData.bytesDownloaded += calculation.bytesDownloaded;
    }
  }

  /**
   * @return {{nodeTimings: Map<Node, LH.Gatherer.Simulation.NodeTiming>, completeNodeTimings: Map<Node, CompleteNodeTiming>}}
   */
  _computeFinalNodeTimings() {
    /** @type {Array<[Node, CompleteNodeTiming]>} */
    const completeNodeTimingEntries = this._nodeTimings.getNodes().map(node => {
      return [node, this._nodeTimings.getCompleted(node)];
    });

    // Most consumers will want the entries sorted by startTime, so insert them in that order
    completeNodeTimingEntries.sort((a, b) => a[1].startTime - b[1].startTime);

    // Trimmed version of type `LH.Gatherer.Simulation.NodeTiming`.
    /** @type {Array<[Node, LH.Gatherer.Simulation.NodeTiming]>} */
    const nodeTimingEntries = completeNodeTimingEntries.map(([node, timing]) => {
      return [node, {
        startTime: timing.startTime,
        endTime: timing.endTime,
        duration: timing.endTime - timing.startTime,
      }];
    });

    return {
      nodeTimings: new Map(nodeTimingEntries),
      completeNodeTimings: new Map(completeNodeTimingEntries),
    };
  }

  /**
   * @return {Required<LH.Gatherer.Simulation.Options>}
   */
  getOptions() {
    return this._options;
  }

  /**
   * Estimates the time taken to process all of the graph's nodes, returns the overall time along with
   * each node annotated by start/end times.
   *
   * If flexibleOrdering is set, simulator/connection pool are allowed to deviate from what was
   * observed in the trace/devtoolsLog and start requests as soon as they are queued (i.e. do not
   * wait around for a warm connection to be available if the original record was fetched on a warm
   * connection).
   *
   * @param {Node} graph
   * @param {{flexibleOrdering?: boolean, label?: string}=} options
   * @return {LH.Gatherer.Simulation.Result}
   */
  simulate(graph, options) {
    if (BaseNode.hasCycle(graph)) {
      throw new Error('Cannot simulate graph with cycle');
    }

    options = Object.assign({
      label: undefined,
      flexibleOrdering: false,
    }, options);

    // initialize the necessary data containers
    this._flexibleOrdering = !!options.flexibleOrdering;
    this._dns = new DNSCache({rtt: this._rtt});
    this._initializeConnectionPool(graph);
    this._initializeAuxiliaryData();

    const nodesNotReadyToStart = this._nodes[NodeState.NotReadyToStart];
    const nodesReadyToStart = this._nodes[NodeState.ReadyToStart];
    const nodesInProgress = this._nodes[NodeState.InProgress];

    const rootNode = graph.getRootNode();
    rootNode.traverse(node => nodesNotReadyToStart.add(node));
    let totalElapsedTime = 0;
    let iteration = 0;

    // root node is always ready to start
    this._markNodeAsReadyToStart(rootNode, totalElapsedTime);

    // loop as long as we have nodes in the queue or currently in progress
    while (nodesReadyToStart.size || nodesInProgress.size) {
      // move all possible queued nodes to in progress
      for (const node of this._getNodesSortedByStartPosition()) {
        this._startNodeIfPossible(node, totalElapsedTime);
      }

      if (!nodesInProgress.size) {
        // interplay between fromDiskCache and connectionReused can be incorrect
        // proceed with flexibleOrdering if we can, otherwise give up
        if (this._flexibleOrdering) throw new Error('Failed to start a node');
        this._flexibleOrdering = true;
        continue;
      }

      // set the available throughput for all connections based on # inflight
      this._updateNetworkCapacity();

      // find the time that the next node will finish
      const minimumTime = this._findNextNodeCompletionTime();
      totalElapsedTime += minimumTime;

      // While this is no longer strictly necessary, it's always better than LH hanging
      if (!Number.isFinite(minimumTime) || iteration > 100000) {
        throw new Error('Simulation failed, depth exceeded');
      }

      iteration++;
      // update how far each node will progress until that point
      for (const node of nodesInProgress) {
        this._updateProgressMadeInTimePeriod(node, minimumTime, totalElapsedTime);
      }
    }

    // `nodeTimings` are used for simulator consumers, `completeNodeTimings` kept for debugging.
    const {nodeTimings, completeNodeTimings} = this._computeFinalNodeTimings();
    ALL_SIMULATION_NODE_TIMINGS.set(options.label || 'unlabeled', completeNodeTimings);

    return {
      timeInMs: totalElapsedTime,
      nodeTimings,
    };
  }

  /**
   * @param {number} wastedBytes
   */
  computeWastedMsFromWastedBytes(wastedBytes) {
    const {throughput, observedThroughput} = this._options;

    // https://github.com/GoogleChrome/lighthouse/pull/13323#issuecomment-962031709
    // 0 throughput means the no (additional) throttling is expected.
    // This is common for desktop + devtools throttling where throttling is additive and we don't want any additional.
    const bitsPerSecond = throughput === 0 ? observedThroughput : throughput;
    if (bitsPerSecond === 0) return 0;

    const wastedBits = wastedBytes * 8;
    const wastedMs = wastedBits / bitsPerSecond * 1000;

    // This is an estimate of wasted time, so we won't be more precise than 10ms.
    return Math.round(wastedMs / 10) * 10;
  }

  /** @return {Map<string, Map<Node, CompleteNodeTiming>>} */
  static get ALL_NODE_TIMINGS() {
    return ALL_SIMULATION_NODE_TIMINGS;
  }

  /**
   * We attempt to start nodes by their observed start time using the record priority as a tie breaker.
   * When simulating, just because a low priority image started 5ms before a high priority image doesn't mean
   * it would have happened like that when the network was slower.
   * @param {Node} node
   */
  static _computeNodeStartPosition(node) {
    if (node.type === 'cpu') return node.startTime;
    return node.startTime + (PriorityStartTimePenalty[node.record.priority] * 1000 * 1000 || 0);
  }
}

export {Simulator};
