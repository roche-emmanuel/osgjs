 //
 // CullVisitor traverse the tree and collect Matrix/State for the rendering traverse
 // and store each traversed node in leaf ready to be rendered
 // Each leaf is stored itsfelf in a renderbin
 // A node can be traversed multiple times, as a node can have multiples parent
 // therefore a Node can be referenced by multiple leaf.
 /**
  * @class CullVisitor
  */
osg.CullVisitor = function () {
    osg.NodeVisitor.call(this);
    osg.CullSettings.call(this);
    osg.CullStack.call(this);

    this._rootStateGraph = undefined;
    this._currentStateGraph = undefined;
    this._currentRenderBin = undefined;
    this._currentRenderStage = undefined;
    this._rootRenderStage = undefined;
    this._currentCullStack = undefined;

    this._computedNear = Number.POSITIVE_INFINITY;
    this._computedFar = Number.NEGATIVE_INFINITY;

    var lookVector =[0.0,0.0,-1.0];
    this._bbCornerFar = (lookVector[0]>=0?1:0) | (lookVector[1]>=0?2:0) | (lookVector[2]>=0?4:0);
    this._bbCornerNear = (~this._bbCornerFar)&7;

    this._sceneGraphDirty = true;

    this._cullStackStack = [];

    // keep a matrix in memory to avoid to allocate/deallocate memory each frame
    // And store previous frame computations if no change in graphs
    // that can change the ordering. (or matrix change)
    this._reserveMatrixStack = [];
    this._reserveMatrixStack.current = -1;

    this._reserveBBoxStack = [];
    this._reserveBBoxStack.current = -1;

    this._reserveLeafStack = [];
    this._reserveLeafStack.current = -1;

    this._renderBinStack = [];
    this._renderBinStack.current = -1;

    this._forceUpdate = false;
};

/** @lends osg.CullVisitor.prototype */
osg.CullVisitor.prototype = osg.objectInehrit(osg.CullStack.prototype ,osg.objectInehrit(osg.CullSettings.prototype, osg.objectInehrit(osg.NodeVisitor.prototype, {

    startCullTransformCallBacks: function(camera, light, scene){

        this.reset();

        this._sceneGraphDirty = this._sceneGraphDirty || scene._dirtySceneGraph;

        var view = this._getReservedMatrix();
        var model = this._getReservedMatrix();
        //if(osg.oldModelViewMatrixMode)
        ////var modelview = this._getReservedMatrix();
        var projection = this._getReservedMatrix();


        if (this._sceneGraphDirty || camera._dirtyMatrix|| this._forceUpdate){
            // absolute
            //if (osg.oldModelViewMatrixMode){
            ////   osg.Matrix.copy(camera.getViewMatrix(), modelview);
            //}
            // camera matrix is inverse view
            osg.Matrix.copy(camera.getViewMatrix(), view);
            osg.Matrix.copy(camera.getProjectionMatrix(), projection);
            osg.Matrix.inverse(camera.getViewMatrix(), model);
            osg.Matrix.makeIdentity(model);
        }
        // as matrix allocated from reserved are
        // initialiazed  to identity

        this.pushStateSet(camera.getStateSet());
        this.pushProjectionMatrix(projection);
        this.pushViewMatrix(view);
        this.pushModelMatrix(model);
        //if(osg.oldModelViewMatrixMode)
        //this.pushModelviewMatrix(modelview);
        this.pushViewport(camera.getViewport());

        // update bound
        // for what ?
        var bs = camera.getBound();
        if (light) {
            this.addPositionedAttribute(light);
        }
        this.setCullSettings(camera);

        if (camera.getViewport())
            this.pushViewport(camera.getViewport());

        this._rootRenderStage.setClearDepth(camera.getClearDepth());
        this._rootRenderStage.setClearColor(camera.getClearColor());
        this._rootRenderStage.setClearMask(camera.getClearMask());
        this._rootRenderStage.setViewport(camera.getViewport());

        //thid.handleCullCallbacksAndTraverse(camera);
        scene.accept(this);

        this.popModelMatrix();
        this.popViewMatrix();
        //if(osg.oldModelViewMatrixMode)
        //this.popModelviewMatrix();
        this.popProjectionMatrix();
        this.popViewport();
        this.popStateSet();


        this._sceneGraphDirty = false;
    },
    //  Computes distance betwen a point and the viewpoint of a matrix  (modelview)
    distance: function(coord, matrix) {
        return -( coord[0]*matrix[2]+ coord[1]*matrix[6] + coord[2]*matrix[10] + matrix[14]);
    },

    handleCullCallbacksAndTraverse: function(node) {
        var ccb = node.getCullCallback();
        if (ccb) {
            if (!ccb.cull(node, this)) {
                return;
            }
        }
        this.traverse(node);
    },
    // distance betwen view and bbox in worldspace
    updateCalculatedNearFar: function(bb,  matrix) {

        var d_near, d_far;

        // efficient computation of near and far, only taking into account the nearest and furthest
        // corners of the bounding box.
        d_near = this.distance(bb.corner(this._bbCornerNear),matrix);
        d_far = this.distance(bb.corner(this._bbCornerFar),matrix);

        if (d_near>d_far) {
            var tmp = d_near;
            d_near = d_far;
            d_far = tmp;
        }

        if (d_far<0.0) {
            // whole object behind the eye point so discard
            return false;
        }

        if (d_near<this._computedNear) {
            this._computedNear = d_near;
        }

        if (d_far>this._computedFar) {
            this._computedFar = d_far;
        }

        return true;
    },

    clampProjectionMatrix: function(projection, znear, zfar, nearFarRatio, resultNearFar) {
        var epsilon = 1e-6;
        if (zfar<znear-epsilon) {
            osg.log("clampProjectionMatrix not applied, invalid depth range, znear = " + znear + "  zfar = " + zfar);
            return false;
        }

        var desired_znear, desired_zfar;
        if (zfar<znear+epsilon) {
            // znear and zfar are too close together and could cause divide by zero problems
            // late on in the clamping code, so move the znear and zfar apart.
            var average = (znear+zfar)*0.5;
            znear = average-epsilon;
            zfar = average+epsilon;
            // OSG_INFO << "_clampProjectionMatrix widening znear and zfar to "<<znear<<" "<<zfar<<std::endl;
        }

        if (Math.abs(osg.Matrix.get(projection,0,3))<epsilon  &&
            Math.abs(osg.Matrix.get(projection,1,3))<epsilon  &&
            Math.abs(osg.Matrix.get(projection,2,3))<epsilon ) {
            // OSG_INFO << "Orthographic matrix before clamping"<<projection<<std::endl;

            var delta_span = (zfar-znear)*0.02;
            if (delta_span<1.0) {
                delta_span = 1.0;
            }
            desired_znear = znear - delta_span;
            desired_zfar = zfar + delta_span;

            // assign the clamped values back to the computed values.
            znear = desired_znear;
            zfar = desired_zfar;

            osg.Matrix.set(projection,2,2, -2.0/(desired_zfar-desired_znear));
            osg.Matrix.set(projection,3,2, -(desired_zfar+desired_znear)/(desired_zfar-desired_znear));

            // OSG_INFO << "Orthographic matrix after clamping "<<projection<<std::endl;
        } else {

            // OSG_INFO << "Persepective matrix before clamping"<<projection<<std::endl;
            //std::cout << "_computed_znear"<<_computed_znear<<std::endl;
            //std::cout << "_computed_zfar"<<_computed_zfar<<std::endl;

            var zfarPushRatio = 1.02;
            var znearPullRatio = 0.98;

            //znearPullRatio = 0.99;

            desired_znear = znear * znearPullRatio;
            desired_zfar = zfar * zfarPushRatio;

            // near plane clamping.
            var min_near_plane = zfar*nearFarRatio;
            if (desired_znear<min_near_plane) {
                desired_znear=min_near_plane;
            }

            // assign the clamped values back to the computed values.
            znear = desired_znear;
            zfar = desired_zfar;

            var m22 = osg.Matrix.get(projection,2,2);
            var m32 = osg.Matrix.get(projection,3,2);
            var m23 = osg.Matrix.get(projection,2,3);
            var m33 = osg.Matrix.get(projection,3,3);
            var trans_near_plane = (-desired_znear*m22 + m32)/(-desired_znear*m23+m33);
            var trans_far_plane = (-desired_zfar*m22+m32)/(-desired_zfar*m23+m33);

            var ratio = Math.abs(2.0/(trans_near_plane-trans_far_plane));
            var center = -(trans_near_plane+trans_far_plane)/2.0;

            var matrix = [1.0,0.0,0.0,0.0,
                          0.0,1.0,0.0,0.0,
                          0.0,0.0,ratio,0.0,
                          0.0,0.0,center*ratio,1.0];
            osg.Matrix.postMult(matrix, projection);
            // OSG_INFO << "Persepective matrix after clamping"<<projection<<std::endl;
        }
        if (resultNearFar !== undefined) {
            resultNearFar[0] = znear;
            resultNearFar[1] = zfar;
        }
        return true;
    },

    setStateGraph: function(sg) {
        this._rootStateGraph = sg;
        this._currentStateGraph = sg;
    },
    setRenderStage: function(rg) {
        this._rootRenderStage = rg;
        this._currentRenderBin = rg;
    },
    reset: function () {

        // they are now kept between frames, unless the scene changes.
        // (added or removed child)
        // TODO: more fine grained scenegraph dirty than whole node graph at each change...
        this.resetMatrixStacks(this._sceneGraphDirty || this._forceUpdate);
        if (this._sceneGraphDirty || this._forceUpdate ){
            this._reserveMatrixStack.current = -1;
            this._reserveBBoxStack.current = -1;
            this._reserveLeafStack.current = -1;
        }
        this.leafIndex = 0;
        this.matrixIndex = 0;
        this.bboxIndex = 0;

        // update those only if Scene matrix other than camera are dirty...
        this._computedNear = Number.POSITIVE_INFINITY;
        this._computedFar = Number.NEGATIVE_INFINITY;
    },
    getCurrentRenderBin: function() { return this._currentRenderBin; },
    setCurrentRenderBin: function(rb) { this._currentRenderBin = rb; },
    addPositionedAttribute: function (attribute) {
        var matrix;
        //if (osg.oldModelViewMatrixMode){
        //   matrix = this.getCurrentModelviewMatrix();
        //}
        //else{
            matrix =this.getCurrentModelMatrix();
        //}
        this._currentRenderBin.getStage().positionedAttribute.push([matrix, attribute]);
    },

    pushStateSet: function (stateset) {
        this._currentStateGraph = this._currentStateGraph.findOrInsert(stateset);
        if (stateset.getBinName() !== undefined) {
            var renderBinStack = this._renderBinStack;
            var currentRenderBin = this._currentRenderBin;
            renderBinStack.push(currentRenderBin);
            this._currentRenderBin = currentRenderBin.getStage().findOrInsert(stateset.getBinNumber(),stateset.getBinName());
        }
    },

    //  Pop the top state set and hence associated state group.
    //  Move the current state group to the parent of the popped
    // state group.
    //
    popStateSet: function () {
        var currentStateGraph = this._currentStateGraph;
        var stateset = currentStateGraph.getStateSet();
        this._currentStateGraph = currentStateGraph.parent;
        if (stateset.getBinName() !== undefined) {
            var renderBinStack = this._renderBinStack;
            if (renderBinStack.length === 0) {
                this._currentRenderBin = this._currentRenderBin.getStage();
            } else {
                this._currentRenderBin = renderBinStack.pop();
            }
        }
    },

    // proxy for cull stack own pop projection matrix
    popProjectionMatrix: function () {
        if (this._computeNearFar === true && this._computedFar >= this._computedNear) {
            var m = this.getCurrentProjectionMatrix();
            this.clampProjectionMatrix(m, this._computedNear, this._computedFar, this._nearFarRatio);
        }
        osg.CullStack.prototype.popProjectionMatrix.call(this);
    },

    apply: function( node ) {
        this[node.objectType].call(this, node);
        //clean whole hierarchy
        //even if no matrix computation in this node
        node._dirtyMatrix = false;
        node._dirtySceneGraph = false;
    },

    // faster path is stack does not change
    //  (and debug out of bounds if it changes when it should not)
    _getReservedMatrix: function() {
        if (this._sceneGraphDirty || this._forceUpdate){
            this._reserveMatrixStack.current++;
            if (this._reserveMatrixStack.current >= this._reserveMatrixStack.length) {
                this._reserveMatrixStack.push(osg.Matrix.makeIdentity([]));
            }
            return this._reserveMatrixStack[this._reserveMatrixStack.current];
        }
        else{
            return this._reserveMatrixStack[this.matrixIndex];
        }
        this.matrixIndex++;
    },
    // faster path is stack does not change
    //  (and debug out of bounds if it changes when it should not)
    _getReservedBBox: function() {
        if (this._sceneGraphDirty || this._forceUpdate){
            this._reserveBBoxStack.current++;
            if (this._reserveBBoxStack.current >= this._reserveBBoxStack.length) {
                this._reserveBBoxStack.push(new osg.BoundingBox());
            }
            return this._reserveBBoxStack[this._reserveBBoxStack.current];
        }
        else{
            return this._reserveBBoxStack[this.bboxIndex];
        }
        this.bboxIndex++;
    },
    _getCurrentBBox: function() {
        return this._reserveMatrixStack[this.bboxIndex];
    },
    // faster path is stack does not change
    //  (and debug out of bounds if it changes when it should not)
    _getReservedLeaf: function() {
        if (this._sceneGraphDirty || this._forceUpdate){
            this._reserveLeafStack.current++;
            if (this._reserveLeafStack.current >= this._reserveLeafStack.length) {
                this._reserveLeafStack.push({});
            }
            return this._reserveLeafStack[this._reserveLeafStack.current];
        }
        else{
            return this._reserveLeafStack[this.leafIndex];
        }
        this.leafIndex++;
    }
})));

osg.CullVisitor.prototype[osg.Camera.prototype.objectType] = function( camera ) {

    var stateset = camera.getStateSet();
    if (stateset) {
        this.pushStateSet(stateset);
    }

    if (camera.light) {
        this.addPositionedAttribute(camera.light);
    }
    var OldtraversalMask = this.traversalMask;
    if (camera.traversalMask) {
        this.traversalMask = camera.traversalMask & this.traversalMask;
    }
    var originalView = this.getCurrentViewMatrix();
    var originalModel = this.getCurrentModelMatrix();
    //if (osg.oldModelViewMatrixMode)
    //var originalModelView = this.getCurrentModelviewMatrix();
    var originalProjectionMatrix = this.getCurrentProjectionMatrix();

    //this._reserveMatrixStack = this.camera._reserveMatrixStack;
    var view = this._getReservedMatrix();
    var model = this._getReservedMatrix();
    var modelview = this._getReservedMatrix();
    var projection = this._getReservedMatrix();

    // note:
    //  camera  getviewmatrix is inverse of matrix model view
    //  camera getmatrix is camera own model matrix

    if (this._sceneGraphDirty || camera._dirtyMatrix|| this._forceUpdate){
        if (camera.getReferenceFrame() === osg.Transform.RELATIVE_RF) {
            osg.Matrix.mult(originalProjectionMatrix, camera.getProjectionMatrix(), projection);

            //if (osg.oldModelViewMatrixMode){
            //osg.Matrix.mult(originalModelView, camera.getViewMatrix(), modelview);
            //}

            osg.Matrix.copy(originalModel, modelview);
            osg.Matrix.mult(originalModel, camera.getViewMatrix(), view);

        } else {
            // absolute
            //if (osg.oldModelViewMatrixMode){
            //   osg.Matrix.copy(camera.getViewMatrix(), modelview);
            //}
            /**/
            // camera matrix is identity  because never set/use to make camera position
            osg.Matrix.makeIdentity(model);
            //osg.Matrix.copy(camera.getViewMatrix(), model);
            /**/
            osg.Matrix.copy(camera.getViewMatrix(), view);
            osg.Matrix.copy(camera.getProjectionMatrix(), projection);
        }
    }
    this.pushProjectionMatrix(projection);
    this.pushViewMatrix(view);
    this.pushModelMatrix(model);
    //if (osg.oldModelViewMatrixMode)
    //this.pushModelviewMatrix(modelview);

    if (camera.getViewport()) {
        this.pushViewport(camera.getViewport());
    }

    // save current state of the camera
    var previous_znear = this._computedNear;
    var previous_zfar = this._computedFar;
    var previous_cullsettings = new osg.CullSettings();
    previous_cullsettings.setCullSettings(this);

    this._computedNear = Number.POSITIVE_INFINITY;
    this._computedFar = Number.NEGATIVE_INFINITY;
    this.setCullSettings(camera);

    // nested camera
    if (camera.getRenderOrder() === osg.Camera.NESTED_RENDER) {

        this.handleCullCallbacksAndTraverse(camera);

    } else {
        // not tested

        var previous_stage = this.getCurrentRenderBin().getStage();


        // use render to texture stage
        var rtts = new osg.RenderStage();
        // caching per camera of sorted render leafs Oppotunitu
        // if (scenegraph is not dirty) reuse renderstage/bin/leaf
        // and just do the cullcback and culling
        // (setting leaf to invisible instead of not adding them ?)
        camera.renderStage = rtts;

        rtts.setCamera(camera);
        rtts.setClearDepth(camera.getClearDepth());
        rtts.setClearColor(camera.getClearColor());
        rtts.setClearMask(camera.getClearMask());

        var vp;
        if (camera.getViewport() === undefined) {
            vp = previous_stage.getViewport();
        } else {
            vp = camera.getViewport();
        }
        rtts.setViewport(vp);

        // skip positional state for now
        // ...

        var previousRenderBin = this.getCurrentRenderBin();

        this.setCurrentRenderBin(rtts);

        this.handleCullCallbacksAndTraverse(camera);

        this.setCurrentRenderBin(previousRenderBin);

        if (camera.getRenderOrder() === osg.Camera.PRE_RENDER) {
            this.getCurrentRenderBin().getStage().addPreRenderStage(rtts, camera.renderOrderNum);
        } else {
            this.getCurrentRenderBin().getStage().addPostRenderStage(rtts, camera.renderOrderNum);
        }
    }

    this.popModelMatrix();
    this.popViewMatrix();
    //if (osg.oldModelViewMatrixMode)
    //this.popModelviewMatrix();
    this.popProjectionMatrix();
    //this.popProjectionMatrix();

        camera.near = this._computedNear;
        camera.far = this._computedFar;

    if (camera.getViewport()) {
        this.popViewport();
    }

    this.traversalMask = OldtraversalMask;
    // restore previous state of the camera
    this.setCullSettings(previous_cullsettings);

    this._computedNear = previous_znear;
    this._computedFar = previous_zfar;

    if (stateset) {
        this.popStateSet();
    }
};

osg.CullVisitor.prototype[osg.MatrixTransform.prototype.objectType] = function (node) {
    var matrixModel = this._getReservedMatrix();
    //if (osg.oldModelViewMatrixMode)
    //var matrixModelview = this._getReservedMatrix();

    if (this._sceneGraphDirty || node._dirtyMatrix|| this._forceUpdate){
        if (node.getReferenceFrame() === osg.Transform.RELATIVE_RF) {
            //if (osg.oldModelViewMatrixMode)
            //var lastmodelviewMatrixStack = this.getCurrentModelviewMatrix();
            //osg.Matrix.mult(lastmodelviewMatrixStack, node.getMatrix(), matrixModelview);

            var lastmodelmatrixStack = this.getCurrentModelMatrix();
            osg.Matrix.mult(lastmodelmatrixStack, node.getMatrix(), matrixModel);
        } else {
            // absolute
            //osg.Matrix.copy(this.getCurrentViewMatrix(), matrixModelview);
            osg.Matrix.copy(node.getMatrix(), matrixModel);
        }
    }
    //if (osg.oldModelViewMatrixMode)
    //this.pushModelviewMatrix(matrixModelview);
    this.pushModelMatrix(matrixModel);


    var stateset = node.getStateSet();
    if (stateset) {
        this.pushStateSet(stateset);
    }

    if (node.light) {
        this.addPositionedAttribute(node.light);
    }

    this.handleCullCallbacksAndTraverse(node);

    if (stateset) {
        this.popStateSet();
    }

    this.popModelMatrix();
    //if (osg.oldModelViewMatrixMode)
    //this.popModelviewMatrix();
};

osg.CullVisitor.prototype[osg.Projection.prototype.objectType] = function (node) {
    var matrix = this._getReservedMatrix();
    if (this._sceneGraphDirty || node.__dirtyMatrix|| this._forceUpdate){
        lastMatrixStack = this.getCurrentProjectionMatrix();
        osg.Matrix.mult(lastMatrixStack, node.getProjectionMatrix(), matrix);
    }
    this.pushProjectionMatrix(matrix);

    var stateset = node.getStateSet();

    if (stateset) {
        this.pushStateSet(stateset);
    }

    this.handleCullCallbacksAndTraverse(node);

    if (stateset) {
        this.popStateSet();
    }

    this.popProjectionMatrix();
};

osg.CullVisitor.prototype[osg.Node.prototype.objectType] = function (node) {

    var stateset = node.getStateSet();
    if (stateset) {
        this.pushStateSet(stateset);
    }
    if (node.light) {
        this.addPositionedAttribute(node.light);
    }

    this.handleCullCallbacksAndTraverse(node);

    if (stateset) {
        this.popStateSet();
    }
};
osg.CullVisitor.prototype[osg.LightSource.prototype.objectType] = function (node) {
    //   TODO: compute lightView (inverse of model view)
    //   for shadows here
    var stateset = node.getStateSet();
    if (stateset) {
        this.pushStateSet(stateset);
    }

    var light = node.getLight();
    if (light) {
        this.addPositionedAttribute(light);
    }

    this.handleCullCallbacksAndTraverse(node);

    if (stateset) {
        this.popStateSet();
    }
};

osg.CullVisitor.prototype[osg.Geometry.prototype.objectType] = function (node) {

    var view = this.getCurrentViewMatrix();
    var model = this.getCurrentModelMatrix();
    // compute upon need
    //var modelview = this.getCurrentModelviewMatrix();

    var bb = this._getReservedBBox();
    if (node._dirtyMatrix || this._sceneGraphDirty || this._forceUpdate){
        var localbb = node.getBoundingBox();
        osg.Matrix.transformVec3( model, localbb._min, bb._min);
        osg.Matrix.transformVec3( model, localbb._max, bb._max);
    }
    if (this._computeNearFar && bb.valid()) {
        if (!this.updateCalculatedNearFar(bb, view)) {
            return;
        }
    }

    var stateset = node.getStateSet();
    if (stateset) {
        this.pushStateSet(stateset);
    }
    this.handleCullCallbacksAndTraverse(node);

    var leafs = this._currentStateGraph.leafs;
    if (leafs.length === 0) {
        this._currentRenderBin.addStateGraph(this._currentStateGraph);
    }

    var leaf = this._getReservedLeaf();
    var depth = 0;
    if (bb.valid()) {
        depth = this.distance(bb.center(), view);
    }
    if (isNaN(depth)) {
        osg.warn("warning geometry has a NaN depth, " + modelview + " center " + bb.center());
    } else {
        // TODO reuse leafs, direclty?
        //  for now give flicker if doing nested cameras
        //if (this._sceneGraphDirty){
            leaf.id = this.leafIndex;
            leaf.parent = this._currentStateGraph;

            leaf.projection = this.getCurrentProjectionMatrix();
            leaf.view = this.getCurrentViewMatrix();
            leaf.model = model;
            //if (node.modelview)
             //   leaf.modelview = modelview;
            //if (node.modelviewNormal)
            //    leaf.modelviewNormal = modelviewNormal;

            leaf.geometry = node;
            leaf.depth = depth;
        //}
        leafs.push(leaf);
    }

    if (stateset) {
        this.popStateSet();
    }
};
