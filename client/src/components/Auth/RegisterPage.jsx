import Footer from "../Footer";
import styles from "../../style";
import Register from "./Register";

const RegisterPage = () => (
  <div className="bg-black w-full overflow-hidden">
    <section className="flex justify-center items-center min-h-[80vh] px-4 py-10">
      <div className="w-full max-w-md">
        <Register />
      </div>
    </section>
    <div className={`bg-primary ${styles.paddingX} ${styles.flexCenter}`}>
      <div className={`${styles.boxWidth}`}>
        <Footer />
      </div>
    </div>
  </div>
);

export default RegisterPage;
