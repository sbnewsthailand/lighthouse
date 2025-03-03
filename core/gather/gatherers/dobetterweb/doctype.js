/**
 * @license Copyright 2018 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import BaseGatherer from '../../base-gatherer.js';

/* global document */

/**
 * Get and return `name`, `publicId`, `systemId` from
 * `document.doctype`
 * and `compatMode` from `document` to check `quirks-mode`
 * @return {{name: string, publicId: string, systemId: string, documentCompatMode: string} | null}
 */
function getDoctype() {
  // An example of this is warnerbros.com/archive/spacejam/movie/jam.htm
  if (!document.doctype) {
    return null;
  }

  const documentCompatMode = document.compatMode;
  const {name, publicId, systemId} = document.doctype;
  return {name, publicId, systemId, documentCompatMode};
}

class Doctype extends BaseGatherer {
  /** @type {LH.Gatherer.GathererMeta} */
  meta = {
    supportedModes: ['snapshot', 'navigation'],
  };

  /**
   * @param {LH.Gatherer.Context} passContext
   * @return {Promise<LH.Artifacts['Doctype']>}
   */
  getArtifact(passContext) {
    const driver = passContext.driver;
    return driver.executionContext.evaluate(getDoctype, {
      args: [],
      useIsolation: true,
    });
  }
}

export default Doctype;
