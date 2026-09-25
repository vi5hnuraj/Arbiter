import styles, { layout } from "../style";
import Button from "./Button";
import LiveAuditPanel from "./LiveAuditPanel";

const CardDeal = () => (
  <section className={layout.section}>
    <div className={layout.sectionInfo}>
      <h2 className={styles.heading2}>
        Policy-controlled <br className="sm:block hidden" /> autonomous payments.
      </h2>
      <p className={`${styles.paragraph} max-w-[470px] mt-5`}>
        AI agents pay within predefined procurement policies. If a payment exceeds the policy, Arbiter requires approval instead of silently allowing it. Autonomy without losing control.
      </p>

      <Button styles={`mt-10`} />
    </div>

    <div className={`${layout.sectionImg} flex justify-center`}>
      <LiveAuditPanel />
    </div>
  </section>
);

export default CardDeal;
