(() => {
  'use strict';
  const options = window.__fixtureOptions || {};
  const db = structuredClone(window.__fixtureData);
  const calls = [];
  let authListener;
  let session = options.signedOut ? null : {access_token: 'local-fixture-token'};
  const errors = {};
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = window.__fixture = {db, calls, errors};
  const result = (data, error = null) => ({data: structuredClone(data), error});
  const query = table => {
    let inserted;
    let changed;
    let operation = 'select';
    const filters = [];
    let single = false;
    const builder = {
      select() { return builder; },
      order() { return builder; },
      insert(value) { inserted = value; operation = 'insert'; return builder; },
      update(value) { changed = value; operation = 'update'; return builder; },
      delete() { operation = 'delete'; return builder; },
      eq(column, value) { filters.push([column, value]); return builder; },
      single() { single = true; return builder; },
      then(resolve, reject) {
        return (async () => {
          calls.push({table, operation, value: inserted || changed, filters});
          if (table === 'members' && !inserted) await wait(options.membersDelay || 0);
          if (errors[table]) return result(null, {message: errors[table]});
          if (inserted) {
            const entry = {id: `fixture-${db[table].length + 1}`, created_at: new Date().toISOString(), ...inserted};
            db[table].unshift(entry);
            return result(single ? entry : [entry]);
          }
          const matches = entry => filters.every(([column, value]) => entry[column] === value);
          if (operation === 'delete') {
            db[table] = db[table].filter(entry => !matches(entry));
            return result(null);
          }
          if (operation === 'update') {
            db[table].filter(matches).forEach(entry => Object.assign(entry, changed));
            return result(null);
          }
          return result(db[table].filter(matches));
        })().then(resolve, reject);
      }
    };
    return builder;
  };
  const client = {
    from: query,
    auth: {
      async getSession() { return result({session}); },
      onAuthStateChange(listener) {
        authListener = listener;
        return {data: {subscription: {unsubscribe() {}}}};
      },
      async signInWithPassword() {
        calls.push({operation: 'login'});
        if (options.loginError) return result(null, {code: 'invalid_credentials', message: 'Invalid login credentials'});
        session = {access_token: 'local-fixture-token'};
        setTimeout(() => authListener('SIGNED_IN', session), 0);
        return result({session});
      },
      async signOut() {
        calls.push({operation: 'logout'});
        if (errors.logout) return result(null, {message: errors.logout});
        session = null;
        authListener('SIGNED_OUT', null);
        return result(null);
      }
    },
    async rpc(name, args) {
      calls.push({rpc: name, args});
      if (errors[name]) return result(null, {message: errors[name]});
      const meal = db.meals.find(entry => entry.id === args.p_meal_id);
      if (name === 'start_meal') {
        if (!meal || meal.creator_member_id !== args.p_actor_member_id || meal.status !== 'waiting') {
          return result(null, {message: 'Only the creator may start a waiting meal.'});
        }
      } else if (name === 'start_neutral_meal') {
        if (!meal || !meal.is_neutral || meal.status !== 'waiting'
          || !db.members.some(member => member.id === args.p_actor_member_id && member.is_active)
          || !args.p_participant_ids.length) {
          return result(null, {message: 'Only an active member may start a neutral waiting meal.'});
        }
      } else if (name === 'share_saved_restaurant') {
        const saved = db.saved_restaurants.find(entry => entry.id === args.p_saved_restaurant_id
          && entry.member_id === args.p_member_id && !entry.shared_at);
        if (!saved) return result(null, {message: 'Saved restaurant was not found or was already shared.'});
        db.meals.unshift({
          ...saved, id: `shared-${saved.id}`, creator_member_id: args.p_member_id,
          is_neutral: false, status: 'waiting', started_at: null, completed_at: null
        });
        saved.shared_at = new Date().toISOString();
        return result(`shared-${saved.id}`);
      }
      if (name === 'start_meal' || name === 'start_neutral_meal') {
        meal.status = 'running';
        meal.started_at = new Date().toISOString();
        db.meal_participants.push(...args.p_participant_ids.map(member_id => ({meal_id: meal.id, member_id})));
      } else if (name === 'submit_meal_rating') {
        const selected = db.meal_participants.filter(entry => entry.meal_id === meal.id);
        if (meal.status !== 'running' || !selected.some(entry => entry.member_id === args.p_member_id)) {
          return result(null, {message: 'Only selected participants may rate a running meal.'});
        }
        if (db.ratings.some(entry => entry.meal_id === meal.id && entry.member_id === args.p_member_id)) {
          return result(null, {message: 'Already rated.'});
        }
        db.ratings.push({
          meal_id: meal.id, member_id: args.p_member_id, rated_at: new Date().toISOString(),
          food: args.p_food, service: args.p_service, ambience: args.p_ambience,
          value_for_money: args.p_value_for_money, comment: args.p_comment
        });
        if (selected.every(entry => db.ratings.some(review => review.meal_id === meal.id && review.member_id === entry.member_id))) {
          meal.status = 'completed';
          meal.completed_at = new Date().toISOString();
        }
      } else {
        throw new Error(`Unexpected fixture RPC: ${name}`);
      }
      return result(null);
    }
  };
  fixture.emitAuth = nextSession => authListener('SIGNED_IN', nextSession);
  window.supabase = {createClient: () => client};
})();
