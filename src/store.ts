import {
  watch,
  computed,
  inject,
  getCurrentInstance,
  reactive,
  DebuggerEvent,
  WatchOptions,
  UnwrapRef,
  markRaw,
  isRef,
  isReactive,
  effectScope,
  EffectScope,
  ComputedRef,
  toRaw,
  toRef,
  toRefs,
  Ref,
  ref,
  set,
  del,
  nextTick,
  isVue2,
} from 'vue-demi'
import {
  StateTree,
  SubscriptionCallback,
  _DeepPartial,
  isPlainObject,
  Store,
  _Method,
  DefineStoreOptions,
  StoreDefinition,
  _GettersTree,
  MutationType,
  StoreOnActionListener,
  _ActionsTree,
  SubscriptionCallbackMutation,
  DefineSetupStoreOptions,
  DefineStoreOptionsInPlugin,
  StoreGeneric,
  _StoreWithGetters,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
  _StoreWithState,
} from './types'
import { setActivePinia, piniaSymbol, Pinia, activePinia } from './rootStore'
import { IS_CLIENT, USE_DEVTOOLS } from './env'
import { patchObject } from './hmr'
import { addSubscription, triggerSubscriptions, noop } from './subscriptions'

type _ArrayType<AT> = AT extends Array<infer T> ? T : never

function mergeReactiveObjects<
  T extends Record<any, unknown> | Map<unknown, unknown> | Set<unknown>
>(target: T, patchToApply: _DeepPartial<T>): T {
  // Handle Map instances
  // 合并Map类型
  if (target instanceof Map && patchToApply instanceof Map) {
    patchToApply.forEach((value, key) => target.set(key, value))
  }
  // Handle Set instances
  // 合并Set类型
  if (target instanceof Set && patchToApply instanceof Set) {
    patchToApply.forEach(target.add, target)
  }

  // no need to go through symbols because they cannot be serialized anyway
  for (const key in patchToApply) {
    if (!patchToApply.hasOwnProperty(key)) continue
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    // 只有普通对象才会进入递归
    if (
      isPlainObject(targetValue) &&
      isPlainObject(subPatch) &&
      target.hasOwnProperty(key) &&
      !isRef(subPatch) &&
      !isReactive(subPatch)
    ) {
      // NOTE: here I wanted to warn about inconsistent types but it's not possible because in setup stores one might
      // start the value of a property as a certain type e.g. a Map, and then for some reason, during SSR, change that
      // to `undefined`. When trying to hydrate, we want to override the Map with `undefined`.
      target[key] = mergeReactiveObjects(targetValue, subPatch)
    } else {
      // @ts-expect-error: subPatch is a valid value
      target[key] = subPatch
    }
  }

  return target
}

const skipHydrateSymbol = __DEV__
  ? Symbol('pinia:skipHydration')
  : /* istanbul ignore next */ Symbol()
const skipHydrateMap = /*#__PURE__*/ new WeakMap<any, any>()

/**
 * Tells Pinia to skip the hydration process of a given object. This is useful in setup stores (only) when you return a
 * stateful object in the store but it isn't really state. e.g. returning a router instance in a setup store.
 *
 * @param obj - target object
 * @returns obj
 */
export function skipHydrate<T = any>(obj: T): T {
  return isVue2
    ? // in @vue/composition-api, the refs are sealed so defineProperty doesn't work...
      /* istanbul ignore next */ skipHydrateMap.set(obj, 1) && obj
    : Object.defineProperty(obj, skipHydrateSymbol, {})
}

/**
 * Returns whether a value should be hydrated
 *
 * @param obj - target variable
 * @returns true if `obj` should be hydrated
 */
function shouldHydrate(obj: any) {
  return isVue2
    ? /* istanbul ignore next */ !skipHydrateMap.has(obj)
    : !isPlainObject(obj) || !obj.hasOwnProperty(skipHydrateSymbol)
}

const { assign } = Object

function isComputed<T>(value: ComputedRef<T> | unknown): value is ComputedRef<T>
function isComputed(o: any): o is ComputedRef {
  return !!(isRef(o) && (o as any).effect)
}

function createOptionsStore<
  Id extends string,
  S extends StateTree,
  G extends _GettersTree<S>,
  A extends _ActionsTree
>(
  id: Id,
  options: DefineStoreOptions<Id, S, G, A>,
  pinia: Pinia,
  hot?: boolean
): Store<Id, S, G, A> {
  const { state, actions, getters } = options

  const initialState: StateTree | undefined = pinia.state.value[id]

  let store: Store<Id, S, G, A>
  // 将options转化成setup函数
  function setup() {
    // 初始化pinia.state
    if (!initialState && (!__DEV__ || !hot)) {
      /* istanbul ignore if */
      if (isVue2) {
        set(pinia.state.value, id, state ? state() : {})
      } else {
        pinia.state.value[id] = state ? state() : {}
      }
    }

    // avoid creating a state in pinia.state.value
    // 将pinia.state全部转换成ref
    const localState =
      __DEV__ && hot
        ? // use ref() to unwrap refs inside state TODO: check if this is still necessary
          toRefs(ref(state ? state() : {}).value)
        : toRefs(pinia.state.value[id])
    
    // 最终options store返回的内容格式和setup store返回的内容格式一致
    return assign(
      localState,
      actions,
      Object.keys(getters || {}).reduce((computedGetters, name) => {
        if (__DEV__ && name in localState) {
          console.warn(
            `[🍍]: A getter cannot have the same name as another state property. Rename one of them. Found with "${name}" in store "${id}".`
          )
        }

        computedGetters[name] = markRaw(
          computed(() => {
            setActivePinia(pinia)
            // it was created just before
            const store = pinia._s.get(id)!

            // allow cross using stores
            /* istanbul ignore next */
            if (isVue2 && !store._r) return

            // @ts-expect-error
            // return getters![name].call(context, context)
            // TODO: avoid reading the getter while assigning with a global variable
            return getters![name].call(store, store)
          })
        )
        return computedGetters
      }, {} as Record<string, ComputedRef>)
    )
  }

  // option选项注册的pinia会被转换成setup函数形式
  store = createSetupStore(id, setup, options, pinia, hot, true)

  store.$reset = function $reset() {
    const newState = state ? state() : {}
    // we use a patch to group all changes into one single subscription
    this.$patch(($state) => {
      assign($state, newState)
    })
  }

  return store as any
}

function createSetupStore<
  Id extends string,
  SS extends Record<any, unknown>,
  S extends StateTree,
  G extends Record<string, _Method>,
  A extends _ActionsTree
>(
  $id: Id,
  setup: () => SS,
  options:
    | DefineSetupStoreOptions<Id, S, G, A>
    | DefineStoreOptions<Id, S, G, A> = {},
  pinia: Pinia,
  hot?: boolean,
  isOptionsStore?: boolean
): Store<Id, S, G, A> {
  let scope!: EffectScope

  const optionsForPlugin: DefineStoreOptionsInPlugin<Id, S, G, A> = assign(
    { actions: {} as A },
    options
  )

  /* istanbul ignore if */
  // @ts-expect-error: active is an internal property
  if (__DEV__ && !pinia._e.active) {
    throw new Error('Pinia destroyed')
  }

  // watcher options for $subscribe
  const $subscribeOptions: WatchOptions = {
    deep: true,
    // flush: 'post',
  }
  /* istanbul ignore else */
  if (__DEV__ && !isVue2) {
    $subscribeOptions.onTrigger = (event) => {
      /* istanbul ignore else */
      if (isListening) {
        debuggerEvents = event
        // avoid triggering this while the store is being built and the state is being set in pinia
      } else if (isListening == false && !store._hotUpdating) {
        // let patch send all the events together later
        /* istanbul ignore else */
        if (Array.isArray(debuggerEvents)) {
          debuggerEvents.push(event)
        } else {
          console.error(
            '🍍 debuggerEvents should be an array. This is most likely an internal Pinia bug.'
          )
        }
      }
    }
  }

  // internal state
  let isListening: boolean // set to true at the end
  let isSyncListening: boolean // set to true at the end

  let subscriptions: SubscriptionCallback<S>[] = markRaw([])
  let actionSubscriptions: StoreOnActionListener<Id, S, G, A>[] = markRaw([])

  let debuggerEvents: DebuggerEvent[] | DebuggerEvent

  const initialState = pinia.state.value[$id] as UnwrapRef<S> | undefined

  // 根据id在pinia上声明对应的state
  if (!isOptionsStore && !initialState && (!__DEV__ || !hot)) {
    /* istanbul ignore if */
    if (isVue2) {
      set(pinia.state.value, $id, {})
    } else {
      pinia.state.value[$id] = {}
    }
  }

  const hotState = ref({} as S)

  // avoid triggering too many listeners
  // https://github.com/vuejs/pinia/issues/1129
  let activeListener: Symbol | undefined

  function $patch(stateMutation: (state: UnwrapRef<S>) => void): void
  function $patch(partialState: _DeepPartial<UnwrapRef<S>>): void
  function $patch(
    partialStateOrMutator:
      | _DeepPartial<UnwrapRef<S>>
      | ((state: UnwrapRef<S>) => void)
  ): void {
    // 订阅$patch操作
    let subscriptionMutation: SubscriptionCallbackMutation<S>
    isListening = isSyncListening = false
    // reset the debugger events since patches are sync
    /* istanbul ignore else */
    if (__DEV__) {
      debuggerEvents = []
    }
    // 兼容$patch的两种调用方式
    if (typeof partialStateOrMutator === 'function') {
      partialStateOrMutator(pinia.state.value[$id] as UnwrapRef<S>)
      subscriptionMutation = {
        type: MutationType.patchFunction,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[],
      }
    } else {
      // 合并$patch方法传递的对象
      mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator)
      subscriptionMutation = {
        type: MutationType.patchObject,
        payload: partialStateOrMutator,
        storeId: $id,
        events: debuggerEvents as DebuggerEvent[],
      }
    }
    const myListenerId = (activeListener = Symbol())
    // 异步还原isListening,让$subscribe不会监听通过$patch修改state
    nextTick().then(() => {
      if (activeListener === myListenerId) {
        isListening = true
      }
    })
    isSyncListening = true
    
    // 手动触发订阅,实现通过$patch批量修改state只触发一次订阅回调
    triggerSubscriptions(
      subscriptions,
      subscriptionMutation,
      pinia.state.value[$id] as UnwrapRef<S>
    )
  }

  /* istanbul ignore next */
  const $reset = __DEV__
    ? () => {
        throw new Error(
          `🍍: Store "${$id}" is built using the setup syntax and does not implement $reset().`
        )
      }
    : noop

  // 卸载store
  function $dispose() {
    scope.stop() //卸载store的scope effect
    subscriptions = []
    actionSubscriptions = []
    pinia._s.delete($id) // 从pinia上删除掉对应的store
  }

  /**
   * Wraps an action to handle subscriptions.
   *
   * @param name - name of the action
   * @param action - action to wrap
   * @returns a wrapped action to handle subscriptions
   */
  // 包装一下action调用，追加发布订阅功能
  function wrapAction(name: string, action: _Method) {
    return function (this: any) {
      // 根据闭包上下文，调用时设置当前活跃的pinia
      setActivePinia(pinia)
      const args = Array.from(arguments)

      const afterCallbackList: Array<(resolvedReturn: any) => any> = []
      const onErrorCallbackList: Array<(error: unknown) => unknown> = []

      function after(callback: _ArrayType<typeof afterCallbackList>) {
        afterCallbackList.push(callback)
      }
      function onError(callback: _ArrayType<typeof onErrorCallbackList>) {
        onErrorCallbackList.push(callback)
      }

      // @ts-expect-error
      // 触发action
      triggerSubscriptions(actionSubscriptions, {
        args,
        name,
        store,
        after,
        onError,
      })

      let ret: any
      try {
        ret = action.apply(this && this.$id === $id ? this : store, args)
        // handle sync errors
      } catch (error) {
        triggerSubscriptions(onErrorCallbackList, error)
        throw error
      }

      if (ret instanceof Promise) {
        return ret
          .then((value) => {
            // 获取到action调用结果后触发
            triggerSubscriptions(afterCallbackList, value)
            return value
          })
          .catch((error) => {
            triggerSubscriptions(onErrorCallbackList, error)
            return Promise.reject(error)
          })
      }

      // allow the afterCallback to override the return value
      triggerSubscriptions(afterCallbackList, ret)
      return ret
    }
  }

  // 热更新的配置对象不会被代理
  const _hmrPayload = /*#__PURE__*/ markRaw({
    actions: {} as Record<string, any>,
    getters: {} as Record<string, Ref>,
    state: [] as string[],
    hotState,
  })

  // 对外暴露的store内容
  const partialStore = {
    _p: pinia,
    // _s: scope,
    $id,
    // 调用$onAction会将回调加入到actionSubscriptions中,wrapAction内会触发回调
    $onAction: addSubscription.bind(null, actionSubscriptions),
    $patch,
    $reset,
    $subscribe(callback, options = {}) {
      const removeSubscription = addSubscription(
        subscriptions,
        callback,
        options.detached,
        () => stopWatcher()
      )
      // 监听state直接修改
      const stopWatcher = scope.run(() =>
        watch(
          () => pinia.state.value[$id] as UnwrapRef<S>,
          (state) => {
            // flush默认为'pre',而在调用$patch时isListening会被设置为false,所以不会触发$patch修改state的监听回调
            if (options.flush === 'sync' ? isSyncListening : isListening) {
              callback(
                {
                  storeId: $id,
                  type: MutationType.direct,
                  events: debuggerEvents as DebuggerEvent,
                },
                state
              )
            }
          },
          assign({}, $subscribeOptions, options)
        )
      )!

      return removeSubscription
    },
    $dispose,
  } as _StoreWithState<Id, S, G, A>

  /* istanbul ignore if */
  if (isVue2) {
    // start as non ready
    partialStore._r = false
  }
  // 返回的store是个reactive对象
  const store: Store<Id, S, G, A> = reactive(
    __DEV__ || USE_DEVTOOLS
      ? assign(
          {
            _hmrPayload,
            _customProperties: markRaw(new Set<string>()), // devtools custom properties
          },
          partialStore
          // must be added later
          // setupStore
        )
      : partialStore
  ) as unknown as Store<Id, S, G, A>

  // 将store注册到pinia上
  pinia._s.set($id, store)

  // TODO: idea create skipSerialize that marks properties as non serializable and they are skipped
  // 将defineStore使用者定义的返回内容放进scope中,在组件卸载时回收effect
  const setupStore = pinia._e.run(() => {
    scope = effectScope()
    return scope.run(() => setup())
  })!

  // overwrite existing actions to support $onAction
  
  // 处理响应式代理
  // pinia.state.value[$id]上的响应式对象同步到setup上
  // setup上的响应式对象同步到pinia.state.value[$id]上
  // 这样使得无论通过pinia操作还是通过store操作，都是操作的同一个代理对象
  for (const key in setupStore) {
    const prop = setupStore[key]
    // 如过value是ref或reactive并且不是computed
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      // mark it as a piece of state to be serialized
      if (__DEV__ && hot) {
        // 将ref、reactive代理对象同步到hotState上,使得改变后能同步更新
        set(hotState.value, key, toRef(setupStore as any, key))
        // createOptionStore directly sets the state in pinia.state.value so we
        // can just skip that
        // option结构已经在createOptionsStore将其加入pinia
      } else if (!isOptionsStore) {
        // in setup stores we must hydrate the state and sync pinia state tree with the refs the user just created
        // 个人理解是同步代理操作
        // 将用户可能直接调用pinia.state.value[$id]设置的ref、reactive对象设置到setup返回的结果上,让二者的响应式都代理一个对象
        // 使得store、pinia能同步更改
        if (initialState && shouldHydrate(prop)) {
          if (isRef(prop)) {
            prop.value = initialState[key]
          } else {
            // probably a reactive object, lets recursively assign
            // 同步其他类型
            mergeReactiveObjects(prop, initialState[key])
          }
        }
        // transfer the ref to the pinia state to keep everything in sync
        // 将setup返回的ref、reactive对象同步到pinia.state上，使得store、pinia能同步更改
        if (isVue2) {
          set(pinia.state.value[$id], key, prop)
        } else {
          pinia.state.value[$id][key] = prop
        }
      }

      /* istanbul ignore else */
      if (__DEV__) {
        _hmrPayload.state.push(key)
      }
      // 将setup中的方法替换成wrapAction包装的方法
    } else if (typeof prop === 'function') {
      // @ts-expect-error: we are overriding the function we avoid wrapping if
      const actionValue = __DEV__ && hot ? prop : wrapAction(key, prop)
      // this a hot module replacement store because the hotUpdate method needs
      // to do it with the right context
      /* istanbul ignore if */
      if (isVue2) {
        set(setupStore, key, actionValue)
      } else {
        // @ts-expect-error
        setupStore[key] = actionValue
      }

      /* istanbul ignore else */
      if (__DEV__) {
        _hmrPayload.actions[key] = prop
      }

      // list actions so they can be used in plugins
      // @ts-expect-error
      optionsForPlugin.actions[key] = prop
    } else if (__DEV__) {
      // add getters for devtools
      if (isComputed(prop)) {
        _hmrPayload.getters[key] = isOptionsStore
          ? // @ts-expect-error
            options.getters[key]
          : prop
        // 为devtools添加getters
        if (IS_CLIENT) {
          const getters: string[] =
            (setupStore._getters as string[]) ||
            // @ts-expect-error: same
            ((setupStore._getters = markRaw([])) as string[])
          getters.push(key)
        }
      }
    }
  }

  // add the state, getters, and action properties
  /* istanbul ignore if */
  // 将setup返回的内容，合并进store对象上
  if (isVue2) {
    Object.keys(setupStore).forEach((key) => {
      set(store, key, setupStore[key])
    })
  } else {
    // 将store的reactive对象、原始对象都进行合并
    assign(store, setupStore)
    // allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
    // Make `storeToRefs()` work with `reactive()` #799
    assign(toRaw(store), setupStore)
  }

  // 劫持store.$state的调用，修改通过$patch
  Object.defineProperty(store, '$state', {
    get: () => (__DEV__ && hot ? hotState.value : pinia.state.value[$id]),
    set: (state) => {
      /* istanbul ignore if */
      if (__DEV__ && hot) {
        throw new Error('cannot set hotState')
      }
      $patch(($state) => {
        assign($state, state)
      })
    },
  })

  // add the hotUpdate before plugins to allow them to override it
  /* istanbul ignore else */

  // 热更新相关，删除合并新的配置内容
  if (__DEV__) {
    store._hotUpdate = markRaw((newStore) => {
      store._hotUpdating = true
      newStore._hmrPayload.state.forEach((stateKey) => {
        if (stateKey in store.$state) {
          const newStateTarget = newStore.$state[stateKey]
          const oldStateSource = store.$state[stateKey]
          if (
            typeof newStateTarget === 'object' &&
            isPlainObject(newStateTarget) &&
            isPlainObject(oldStateSource)
          ) {
            patchObject(newStateTarget, oldStateSource)
          } else {
            // transfer the ref
            // 同步旧的ref到新的store上
            newStore.$state[stateKey] = oldStateSource
          }
        }
        // patch direct access properties to allow store.stateProperty to work as
        // store.$state.stateProperty
        // 将新state设置到store上,使得store.x等价于newStore.$state.x
        set(store, stateKey, toRef(newStore.$state, stateKey))
      })

      // remove deleted state properties
      // 删除已经没有的state
      Object.keys(store.$state).forEach((stateKey) => {
        if (!(stateKey in newStore.$state)) {
          del(store, stateKey)
        }
      })

      // avoid devtools logging this as a mutation
      isListening = false
      isSyncListening = false
      pinia.state.value[$id] = toRef(newStore._hmrPayload, 'hotState')
      isSyncListening = true
      nextTick().then(() => {
        isListening = true
      })
      
      // 更新action
      for (const actionName in newStore._hmrPayload.actions) {
        const action: _Method = newStore[actionName]

        set(store, actionName, wrapAction(actionName, action))
      }

      // TODO: does this work in both setup and option store?
      for (const getterName in newStore._hmrPayload.getters) {
        const getter: _Method = newStore._hmrPayload.getters[getterName]
        const getterValue = isOptionsStore
          ? // special handling of options api
            computed(() => {
              setActivePinia(pinia)
              return getter.call(store, store)
            })
          : getter

        set(store, getterName, getterValue)
      }

      // remove deleted getters
      Object.keys(store._hmrPayload.getters).forEach((key) => {
        if (!(key in newStore._hmrPayload.getters)) {
          del(store, key)
        }
      })

      // remove old actions
      Object.keys(store._hmrPayload.actions).forEach((key) => {
        if (!(key in newStore._hmrPayload.actions)) {
          del(store, key)
        }
      })

      // update the values used in devtools and to allow deleting new properties later on
      store._hmrPayload = newStore._hmrPayload
      store._getters = newStore._getters
      store._hotUpdating = false
    })
  }

  if (USE_DEVTOOLS) {
    const nonEnumerable = {
      writable: true,
      configurable: true,
      // avoid warning on devtools trying to display this property
      enumerable: false,
    }

    // avoid listing internal properties in devtools
    ;(['_p', '_hmrPayload', '_getters', '_customProperties'] as const).forEach(
      (p) => {
        Object.defineProperty(store, p, {
          value: store[p],
          ...nonEnumerable,
        })
      }
    )
  }

  /* istanbul ignore if */
  if (isVue2) {
    // mark the store as ready before plugins
    store._r = true
  }

  // apply all plugins
  pinia._p.forEach((extender) => {
    /* istanbul ignore else */
    if (USE_DEVTOOLS) {
      const extensions = scope.run(() =>
        extender({
          store,
          app: pinia._a,
          pinia,
          options: optionsForPlugin,
        })
      )!
      Object.keys(extensions || {}).forEach((key) =>
        store._customProperties.add(key)
      )
      assign(store, extensions)
    } else {
      assign(
        store,
        scope.run(() =>
          extender({
            store,
            app: pinia._a,
            pinia,
            options: optionsForPlugin,
          })
        )!
      )
    }
  })

  if (
    __DEV__ &&
    store.$state &&
    typeof store.$state === 'object' &&
    typeof store.$state.constructor === 'function' &&
    !store.$state.constructor.toString().includes('[native code]')
  ) {
    console.warn(
      `[🍍]: The "state" must be a plain object. It cannot be\n` +
        `\tstate: () => new MyClass()\n` +
        `Found in store "${store.$id}".`
    )
  }

  // only apply hydrate to option stores with an initial state in pinia
  if (
    initialState &&
    isOptionsStore &&
    (options as DefineStoreOptions<Id, S, G, A>).hydrate
  ) {
    ;(options as DefineStoreOptions<Id, S, G, A>).hydrate!(
      store.$state,
      initialState
    )
  }

  // store创建完成,可以进行监听订阅操作
  isListening = true
  isSyncListening = true
  return store
}

/**
 * Extract the actions of a store type. Works with both a Setup Store or an
 * Options Store.
 */
export type StoreActions<SS> = SS extends Store<
  string,
  StateTree,
  _GettersTree<StateTree>,
  infer A
>
  ? A
  : _ExtractActionsFromSetupStore<SS>

/**
 * Extract the getters of a store type. Works with both a Setup Store or an
 * Options Store.
 */
export type StoreGetters<SS> = SS extends Store<
  string,
  StateTree,
  infer G,
  _ActionsTree
>
  ? _StoreWithGetters<G>
  : _ExtractGettersFromSetupStore<SS>

/**
 * Extract the state of a store type. Works with both a Setup Store or an
 * Options Store. Note this unwraps refs.
 */
export type StoreState<SS> = SS extends Store<
  string,
  infer S,
  _GettersTree<StateTree>,
  _ActionsTree
>
  ? UnwrapRef<S>
  : _ExtractStateFromSetupStore<SS>

// type a1 = _ExtractStateFromSetupStore<{ a: Ref<number>; action: () => void }>
// type a2 = _ExtractActionsFromSetupStore<{ a: Ref<number>; action: () => void }>
// type a3 = _ExtractGettersFromSetupStore<{
//   a: Ref<number>
//   b: ComputedRef<string>
//   action: () => void
// }>

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param id - id of the store (must be unique)
 * @param options - options to define the store
 */
export function defineStore<
  Id extends string,
  S extends StateTree = {},
  G extends _GettersTree<S> = {},
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */ = {}
>(
  id: Id,
  options: Omit<DefineStoreOptions<Id, S, G, A>, 'id'>
): StoreDefinition<Id, S, G, A>

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param options - options to define the store
 */
export function defineStore<
  Id extends string,
  S extends StateTree = {},
  G extends _GettersTree<S> = {},
  // cannot extends ActionsTree because we loose the typings
  A /* extends ActionsTree */ = {}
>(options: DefineStoreOptions<Id, S, G, A>): StoreDefinition<Id, S, G, A>

/**
 * Creates a `useStore` function that retrieves the store instance
 *
 * @param id - id of the store (must be unique)
 * @param storeSetup - function that defines the store
 * @param options - extra options
 */
export function defineStore<Id extends string, SS>(
  id: Id,
  storeSetup: () => SS,
  options?: DefineSetupStoreOptions<
    Id,
    _ExtractStateFromSetupStore<SS>,
    _ExtractGettersFromSetupStore<SS>,
    _ExtractActionsFromSetupStore<SS>
  >
): StoreDefinition<
  Id,
  _ExtractStateFromSetupStore<SS>,
  _ExtractGettersFromSetupStore<SS>,
  _ExtractActionsFromSetupStore<SS>
>
export function defineStore(
  // TODO: add proper types from above
  idOrOptions: any,
  setup?: any,
  setupOptions?: any
): StoreDefinition {
  let id: string
  let options:
    | DefineStoreOptions<
        string,
        StateTree,
        _GettersTree<StateTree>,
        _ActionsTree
      >
    | DefineSetupStoreOptions<
        string,
        StateTree,
        _GettersTree<StateTree>,
        _ActionsTree
      >

  const isSetupStore = typeof setup === 'function'
  // 兼容不同格式参数
  if (typeof idOrOptions === 'string') {
    id = idOrOptions
    // the option store setup will contain the actual options in this case
    options = isSetupStore ? setupOptions : setup
  } else {
    options = idOrOptions
    id = idOrOptions.id
  }

  function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric {
    const currentInstance = getCurrentInstance()
    // 如果存在currentInstance说明在vue组件中，通过inject获取到pinia
    pinia =
      (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
      (currentInstance && inject(piniaSymbol, null))
    
      //设置当前活跃的pinia对象，如果存在多个pinia对象，方便快速获取当前pinia对象
    if (pinia) setActivePinia(pinia)

    if (__DEV__ && !activePinia) {
      throw new Error(
        `[🍍]: getActivePinia was called with no active Pinia. Did you forget to install pinia?\n` +
          `\tconst pinia = createPinia()\n` +
          `\tapp.use(pinia)\n` +
          `This will fail in production.`
      )
    }
    // 从rootStore文件中取的全局变量
    pinia = activePinia!
    // 如果没有创建过id对应的store,则会调用createSetupStore或createOptionsStore进行创建
    if (!pinia._s.has(id)) {
      // 区分第二个参数是函数还是options对象
      if (isSetupStore) {
        createSetupStore(id, setup, options, pinia)
      } else {
        createOptionsStore(id, options as any, pinia)
      }

      /* istanbul ignore else */
      if (__DEV__) {
        // @ts-expect-error: not the right inferred type
        useStore._pinia = pinia
      }
    }
    // 获取上面创建好的store
    const store: StoreGeneric = pinia._s.get(id)!
    // 热更新相关,重新创建store
    if (__DEV__ && hot) {
      const hotId = '__hot:' + id
      const newStore = isSetupStore
        ? createSetupStore(hotId, setup, options, pinia, true)
        : createOptionsStore(hotId, assign({}, options) as any, pinia, true)

      hot._hotUpdate(newStore)

      // cleanup the state properties and the store from the cache
      delete pinia.state.value[hotId]
      pinia._s.delete(hotId)
    }

    // save stores in instances to access them devtools
    // 往当前组件实例上缓存store
    if (
      __DEV__ &&
      IS_CLIENT &&
      currentInstance &&
      currentInstance.proxy &&
      // avoid adding stores that are just built for hot module replacement
      !hot
    ) {
      const vm = currentInstance.proxy
      const cache = '_pStores' in vm ? vm._pStores! : (vm._pStores = {})
      cache[id] = store
    }

    // StoreGeneric cannot be casted towards Store
    return store as any
  }

  useStore.$id = id

  return useStore
}
